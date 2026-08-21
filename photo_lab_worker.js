'use strict';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const smoothstep = (edge0, edge1, value) => {
    const position = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
    return position * position * (3 - 2 * position);
};

function estimateNoise(luma, width, height) {
    const histogram = new Uint32Array(64);
    const stride = Math.max(1, Math.floor(Math.sqrt(width * height / 180000)));
    let samples = 0;
    for (let y = 1; y < height - 1; y += stride) {
        for (let x = 1; x < width - 1; x += stride) {
            const pixel = y * width + x;
            const left = luma[pixel - 1], right = luma[pixel + 1];
            const top = luma[pixel - width], bottom = luma[pixel + width];
            const minimum = Math.min(left, right, top, bottom);
            const maximum = Math.max(left, right, top, bottom);
            if (maximum - minimum > 28) continue;
            const residual = Math.min(63, Math.round(Math.abs(luma[pixel] - (left + right + top + bottom) * 0.25)));
            histogram[residual]++;
            samples++;
        }
    }
    if (!samples) return 4;
    const target = samples * 0.5;
    let total = 0;
    for (let residual = 0; residual < histogram.length; residual++) {
        total += histogram[residual];
        if (total >= target) return clamp(residual * 1.48, 1.5, 24);
    }
    return 4;
}

function denoisePass(source, width, height, strength, settings = {}) {
    const pixelCount = width * height;
    const luminance = new Float32Array(pixelCount);
    const orangeBlue = new Float32Array(pixelCount);
    const greenMagenta = new Float32Array(pixelCount);
    for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
        const red = source[index], green = source[index + 1], blue = source[index + 2];
        luminance[pixel] = (red + green * 2 + blue) * 0.25;
        orangeBlue[pixel] = red - blue;
        greenMagenta[pixel] = green - (red + blue) * 0.5;
    }

    const noise = estimateNoise(luminance, width, height);
    const lumaControl = clamp(Number(settings.denoiseLuminance ?? 45), 0, 100) / 100;
    const chromaControl = clamp(Number(settings.denoiseChroma ?? 70), 0, 100) / 100;
    const detailControl = clamp(Number(settings.denoiseDetail ?? 60), 0, 100) / 100;
    // The controls are perceptual: mid-range values must already produce a visible
    // result, while the bilateral weights and detail mask keep genuine edges intact.
    const lumaBase = [0, 0.52, 0.78, 1][strength] * Math.pow(lumaControl, 0.72);
    const chromaBase = [0, 0.62, 0.84, 1][strength] * Math.pow(chromaControl, 0.7);
    let radius = [0, 1, 2, 3][strength];
    if (pixelCount > 22000000) radius = Math.min(radius, 1);
    else if (pixelCount > 9000000) radius = Math.min(radius, 2);
    const spatialSigma = Math.max(0.8, radius * 0.78);
    const rangeSigma = Math.max(5, noise * (2.45 + strength * 0.48) + strength * 2.8);
    const rangeWeights = new Float32Array(256);
    for (let difference = 0; difference < rangeWeights.length; difference++) {
        rangeWeights[difference] = Math.exp(-(difference * difference) / (2 * rangeSigma * rangeSigma));
    }
    const kernelSize = radius * 2 + 1;
    const spatialWeights = new Float32Array(kernelSize * kernelSize);
    for (let offsetY = -radius, kernel = 0; offsetY <= radius; offsetY++) {
        for (let offsetX = -radius; offsetX <= radius; offsetX++, kernel++) {
            spatialWeights[kernel] = Math.exp(-(offsetX * offsetX + offsetY * offsetY) / (2 * spatialSigma * spatialSigma));
        }
    }

    const output = new Uint8ClampedArray(source.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            const centerLuma = luminance[pixel];
            let filteredLuma = 0, filteredOrangeBlue = 0, filteredGreenMagenta = 0, total = 0, kernel = 0;
            for (let offsetY = -radius; offsetY <= radius; offsetY++) {
                const sampleY = clamp(y + offsetY, 0, height - 1);
                for (let offsetX = -radius; offsetX <= radius; offsetX++, kernel++) {
                    const sampleX = clamp(x + offsetX, 0, width - 1);
                    const sample = sampleY * width + sampleX;
                    const difference = Math.min(255, Math.round(Math.abs(luminance[sample] - centerLuma)));
                    const weight = spatialWeights[kernel] * rangeWeights[difference];
                    filteredLuma += luminance[sample] * weight;
                    filteredOrangeBlue += orangeBlue[sample] * weight;
                    filteredGreenMagenta += greenMagenta[sample] * weight;
                    total += weight;
                }
            }
            filteredLuma /= total;
            filteredOrangeBlue /= total;
            filteredGreenMagenta /= total;

            const left = luminance[y * width + Math.max(0, x - 1)];
            const right = luminance[y * width + Math.min(width - 1, x + 1)];
            const top = luminance[Math.max(0, y - 1) * width + x];
            const bottom = luminance[Math.min(height - 1, y + 1) * width + x];
            const edge = Math.hypot(right - left, bottom - top);
            const edgeProtection = smoothstep(noise * 1.5 + 3, noise * 5 + 24, edge);
            const texture = Math.abs(centerLuma - filteredLuma);
            const textureProtection = smoothstep(noise * 1.1 + 1, noise * 3.8 + 12, texture) * detailControl * (1 - strength * 0.06);
            const lumaAmount = lumaBase * (1 - Math.max(edgeProtection, textureProtection) * 0.9);
            const chromaAmount = chromaBase * (1 - edgeProtection * detailControl * 0.48);
            const outputLuma = centerLuma + (filteredLuma - centerLuma) * lumaAmount;
            const outputOrangeBlue = orangeBlue[pixel] + (filteredOrangeBlue - orangeBlue[pixel]) * chromaAmount;
            const outputGreenMagenta = greenMagenta[pixel] + (filteredGreenMagenta - greenMagenta[pixel]) * chromaAmount;
            const intermediate = outputLuma - outputGreenMagenta * 0.5;
            const blue = intermediate - outputOrangeBlue * 0.5;
            const red = blue + outputOrangeBlue;
            const green = intermediate + outputGreenMagenta;
            const index = pixel * 4;
            output[index] = clamp(red, 0, 255);
            output[index + 1] = clamp(green, 0, 255);
            output[index + 2] = clamp(blue, 0, 255);
            output[index + 3] = source[index + 3];
        }
    }
    return output;
}

function analyze(pixels, minimumLuma = 0) {
    const histogram = new Uint32Array(256);
    const pixelCount = pixels.length / 4;
    const stride = Math.max(1, Math.floor(pixelCount / 220000));
    let red = 0, green = 0, blue = 0, samples = 0;
    for (let pixel = 0; pixel < pixelCount; pixel += stride) {
        const index = pixel * 4;
        if (pixels[index + 3] < 16) continue;
        const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
        const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
        if (luma < minimumLuma) continue;
        histogram[Math.round(luma)]++;
        red += r; green += g; blue += b; samples++;
    }
    const percentile = fraction => {
        const target = Math.max(1, Math.round(samples * fraction));
        let total = 0;
        for (let value = 0; value < 256; value++) {
            total += histogram[value];
            if (total >= target) return value;
        }
        return 255;
    };
    let weightedTotal = 0;
    for (let value = 0; value < 256; value++) weightedTotal += value * histogram[value];
    let backgroundWeight = 0, backgroundTotal = 0, maximumVariance = -1, separation = 0;
    for (let value = 0; value < 256; value++) {
        backgroundWeight += histogram[value];
        if (backgroundWeight === 0) continue;
        const foregroundWeight = samples - backgroundWeight;
        if (foregroundWeight === 0) break;
        backgroundTotal += value * histogram[value];
        const backgroundMean = backgroundTotal / backgroundWeight;
        const foregroundMean = (weightedTotal - backgroundTotal) / foregroundWeight;
        const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
        if (variance > maximumVariance) {
            maximumVariance = variance;
            separation = value;
        }
    }
    return {
        black: percentile(0.008),
        white: percentile(0.992),
        red: red / Math.max(1, samples),
        green: green / Math.max(1, samples),
        blue: blue / Math.max(1, samples),
        mean: histogram.reduce((sum, count, value) => sum + count * value, 0) / Math.max(1, samples),
        separation,
    };
}

function applyLook(pixels, preset) {
    if (preset === 'none') return pixels;
    const completeStats = analyze(pixels);
    const silhouette = preset === 'silhouette';
    const silhouetteThreshold = clamp(completeStats.separation, 12, 150);
    const stats = silhouette ? analyze(pixels, silhouetteThreshold + 8) : completeStats;
    const vivid = preset === 'dynamic';
    const dynamic = vivid || preset === 'bw-contrast' || silhouette;
    const monochrome = preset === 'bw' || preset === 'bw-contrast';
    const neutral = (stats.red + stats.green + stats.blue) / 3;
    const balanceLimit = dynamic ? [0.76, 1.24] : [0.84, 1.16];
    const gains = [stats.red, stats.green, stats.blue].map(channel => clamp(neutral / Math.max(1, channel), balanceLimit[0], balanceLimit[1]));
    const black = Math.min(24, stats.black);
    const white = vivid ? Math.max(232, stats.white) : Math.max(178, stats.white);
    const range = Math.max(80, white - black);
    const normalizedMean = clamp((stats.mean - black) / range, 0.08, 0.92);
    const target = vivid ? 0.49 : (dynamic ? 0.51 : 0.48);
    const gamma = clamp(Math.log(target) / Math.log(normalizedMean), 0.72, 1.32);
    const contrast = preset === 'bw-contrast' ? 1.22 : (vivid ? 1.07 : (dynamic ? 1.12 : 1.04));
    const saturation = monochrome ? 0 : (vivid ? 1.08 : (dynamic ? 1.12 : 1.04));

    for (let index = 0; index < pixels.length; index += 4) {
        const originalChannels = [pixels[index] / 255, pixels[index + 1] / 255, pixels[index + 2] / 255];
        const originalLuminance = originalChannels[0] * 0.2126 + originalChannels[1] * 0.7152 + originalChannels[2] * 0.0722;
        let channels = [
            clamp((pixels[index] * gains[0] - black) / range, 0, 1),
            clamp((pixels[index + 1] * gains[1] - black) / range, 0, 1),
            clamp((pixels[index + 2] * gains[2] - black) / range, 0, 1),
        ].map(value => clamp((Math.pow(value, gamma) - 0.5) * contrast + 0.5, 0, 1));
        if (vivid) {
            channels = channels.map(value => {
                if (value <= 0.68) return value;
                const position = (value - 0.68) / 0.32;
                return 0.68 + 0.32 * (position - 0.12 * position * position);
            });
        }
        const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        const subjectMask = silhouette
            ? smoothstep((silhouetteThreshold + 4) / 255, (silhouetteThreshold + 64) / 255, originalLuminance)
            : 1;
        if (monochrome) {
            const gray = clamp(luminance * 255, 0, 255);
            pixels[index] = (originalChannels[0] + (gray / 255 - originalChannels[0]) * subjectMask) * 255;
            pixels[index + 1] = (originalChannels[1] + (gray / 255 - originalChannels[1]) * subjectMask) * 255;
            pixels[index + 2] = (originalChannels[2] + (gray / 255 - originalChannels[2]) * subjectMask) * 255;
        } else {
            for (let channel = 0; channel < 3; channel++) {
                let treated = clamp(luminance + (channels[channel] - luminance) * saturation, 0, 1);
                if (vivid && treated > 0.68) {
                    const position = (treated - 0.68) / 0.32;
                    treated = 0.68 + 0.32 * (position - 0.12 * position * position);
                }
                pixels[index + channel] = (originalChannels[channel] + (treated - originalChannels[channel]) * subjectMask) * 255;
            }
        }
    }
    return pixels;
}

function blendAutomaticLook(base, treated, strength) {
    const amount = clamp(Number(strength) || 0, 0, 100) / 100;
    if (amount >= 1) return treated;
    for (let index = 0; index < treated.length; index += 4) {
        for (let channel = 0; channel < 3; channel++) {
            treated[index + channel] = base[index + channel] + (treated[index + channel] - base[index + channel]) * amount;
        }
    }
    return treated;
}

function applyWhiteBalance(pixels, temperature, tint) {
    const warmth = clamp(Number(temperature) || 0, -100, 100) / 100;
    const magenta = clamp(Number(tint) || 0, -100, 100) / 100;
    if (warmth === 0 && magenta === 0) return pixels;
    const gains = [1 + warmth * 0.18 + magenta * 0.05, 1 - magenta * 0.12, 1 - warmth * 0.18 + magenta * 0.05];
    for (let index = 0; index < pixels.length; index += 4) {
        pixels[index] = clamp(pixels[index] * gains[0], 0, 255);
        pixels[index + 1] = clamp(pixels[index + 1] * gains[1], 0, 255);
        pixels[index + 2] = clamp(pixels[index + 2] * gains[2], 0, 255);
    }
    return pixels;
}

function applyBasicAdjustments(pixels, exposure, contrast, whites, blacks) {
    const exposureFactor = 2 ** clamp(Number(exposure) || 0, -2, 2);
    const contrastFactor = 1 + clamp(Number(contrast) || 0, -100, 100) / 100 * 0.78;
    const whiteAmount = clamp(Number(whites) || 0, -100, 100) / 100;
    const blackAmount = clamp(Number(blacks) || 0, -100, 100) / 100;
    if (exposureFactor === 1 && contrastFactor === 1 && whiteAmount === 0 && blackAmount === 0) return pixels;
    for (let index = 0; index < pixels.length; index += 4) {
        let channels = [pixels[index] / 255, pixels[index + 1] / 255, pixels[index + 2] / 255]
            .map(value => clamp((value * exposureFactor - 0.5) * contrastFactor + 0.5, 0, 1));
        const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        const whiteMask = smoothstep(0.42, 1, luminance) ** 2;
        const blackMask = (1 - smoothstep(0, 0.58, luminance)) ** 2;
        channels = channels.map(value => {
            if (whiteAmount >= 0) value += (1 - value) * whiteAmount * whiteMask * 0.5;
            else value += value * whiteAmount * whiteMask * 0.72;
            if (blackAmount >= 0) value += (1 - value) * blackAmount * blackMask * 0.34;
            else value += value * blackAmount * blackMask * 0.72;
            return clamp(value, 0, 1);
        });
        pixels[index] = channels[0] * 255;
        pixels[index + 1] = channels[1] * 255;
        pixels[index + 2] = channels[2] * 255;
    }
    return pixels;
}

function applyToneCurve(pixels, curve) {
    if (!curve || curve === 'linear') return pixels;
    const curveValue = value => {
        const sCurve = value * value * (3 - 2 * value);
        if (curve === 'soft-s') return value + (sCurve - value) * 0.42;
        if (curve === 'strong-s') return value + (sCurve - value) * 0.76;
        if (curve === 'matte') return 0.055 + (value + (sCurve - value) * 0.28) * 0.925;
        return value;
    };
    for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index] / 255, green = pixels[index + 1] / 255, blue = pixels[index + 2] / 255;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        const mapped = clamp(curveValue(luminance), 0, 1);
        const shift = mapped - luminance;
        pixels[index] = clamp((red + shift) * 255, 0, 255);
        pixels[index + 1] = clamp((green + shift) * 255, 0, 255);
        pixels[index + 2] = clamp((blue + shift) * 255, 0, 255);
    }
    return pixels;
}

function applyVibrance(pixels, vibrance) {
    const amount = clamp(Number(vibrance) || 0, -100, 100) / 100;
    if (amount === 0) return pixels;
    for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index] / 255, green = pixels[index + 1] / 255, blue = pixels[index + 2] / 255;
        const maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue);
        const colorfulness = maximum - minimum;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        const factor = 1 + amount * (amount > 0 ? (1 - colorfulness) * 0.9 : 0.72);
        pixels[index] = clamp((luminance + (red - luminance) * factor) * 255, 0, 255);
        pixels[index + 1] = clamp((luminance + (green - luminance) * factor) * 255, 0, 255);
        pixels[index + 2] = clamp((luminance + (blue - luminance) * factor) * 255, 0, 255);
    }
    return pixels;
}

function applyLocalDetail(pixels, width, height, clarity, sharpening) {
    const clarityAmount = clamp(Number(clarity) || 0, -100, 100) / 100;
    const sharpeningAmount = clamp(Number(sharpening) || 0, 0, 100) / 100;
    if (clarityAmount === 0 && sharpeningAmount === 0) return pixels;
    const source = new Uint8ClampedArray(pixels);
    const lumaAt = (x, y) => {
        const index = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
        return source[index] * 0.2126 + source[index + 1] * 0.7152 + source[index + 2] * 0.0722;
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const center = lumaAt(x, y);
            const fineAverage = (lumaAt(x - 1, y) + lumaAt(x + 1, y) + lumaAt(x, y - 1) + lumaAt(x, y + 1)) / 4;
            const broadAverage = (lumaAt(x - 2, y) + lumaAt(x + 2, y) + lumaAt(x, y - 2) + lumaAt(x, y + 2)) / 4;
            const correction = clamp((center - broadAverage) * clarityAmount * 0.58 + (center - fineAverage) * sharpeningAmount * 0.92, -30, 30);
            for (let channel = 0; channel < 3; channel++) pixels[index + channel] = clamp(source[index + channel] + correction, 0, 255);
        }
    }
    return pixels;
}

function applyDehaze(pixels, dehaze) {
    const amount = clamp(Number(dehaze) || 0, -100, 100) / 100;
    if (amount === 0) return pixels;
    const pivot = clamp(analyze(pixels).mean / 255, 0.18, 0.72);
    const contrast = 1 + amount * 0.55;
    const veil = amount >= 0 ? -amount * 0.035 : -amount * 0.07;
    const colorStrength = 1 + amount * 0.24;
    for (let index = 0; index < pixels.length; index += 4) {
        const channels = [pixels[index] / 255, pixels[index + 1] / 255, pixels[index + 2] / 255]
            .map(value => clamp((value - pivot) * contrast + pivot + veil, 0, 1));
        const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        for (let channel = 0; channel < 3; channel++) {
            pixels[index + channel] = clamp((luminance + (channels[channel] - luminance) * colorStrength) * 255, 0, 255);
        }
    }
    return pixels;
}

function applySaturation(pixels, saturation) {
    const amount = clamp(Number(saturation) || 0, -100, 100) / 100;
    if (amount === 0) return pixels;
    const strength = 1 + amount;
    for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index] / 255, green = pixels[index + 1] / 255, blue = pixels[index + 2] / 255;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        pixels[index] = clamp((luminance + (red - luminance) * strength) * 255, 0, 255);
        pixels[index + 1] = clamp((luminance + (green - luminance) * strength) * 255, 0, 255);
        pixels[index + 2] = clamp((luminance + (blue - luminance) * strength) * 255, 0, 255);
    }
    return pixels;
}

const HSL_CENTERS = {red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 285, magenta: 330};

function rgbToHsl(red, green, blue) {
    const maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue);
    const lightness = (maximum + minimum) / 2;
    if (maximum === minimum) return [0, 0, lightness];
    const difference = maximum - minimum;
    const saturation = lightness > 0.5 ? difference / (2 - maximum - minimum) : difference / (maximum + minimum);
    let hue;
    if (maximum === red) hue = (green - blue) / difference + (green < blue ? 6 : 0);
    else if (maximum === green) hue = (blue - red) / difference + 2;
    else hue = (red - green) / difference + 4;
    return [hue * 60, saturation, lightness];
}

function hslToRgb(hue, saturation, lightness) {
    hue = ((hue % 360) + 360) % 360 / 360;
    if (saturation === 0) return [lightness, lightness, lightness];
    const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;
    const component = offset => {
        let value = hue + offset;
        if (value < 0) value += 1; if (value > 1) value -= 1;
        if (value < 1 / 6) return p + (q - p) * 6 * value;
        if (value < 1 / 2) return q;
        if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
        return p;
    };
    return [component(1 / 3), component(0), component(-1 / 3)];
}

function applyHslMixer(pixels, mixer) {
    const active = Object.entries(mixer || {}).filter(([, values]) => values && (values.hue || values.saturation || values.luminance));
    if (!active.length) return pixels;
    for (let index = 0; index < pixels.length; index += 4) {
        let [hue, saturation, lightness] = rgbToHsl(pixels[index] / 255, pixels[index + 1] / 255, pixels[index + 2] / 255);
        if (saturation < 0.015) continue;
        let best = null, bestDistance = Infinity;
        for (const [channel, values] of active) {
            const distance = Math.abs(((hue - HSL_CENTERS[channel] + 540) % 360) - 180);
            if (distance < bestDistance) { bestDistance = distance; best = values; }
        }
        if (!best || bestDistance > 42) continue;
        const weight = 1 - smoothstep(24, 42, bestDistance);
        hue += (Number(best.hue) || 0) * 0.32 * weight;
        saturation = clamp(saturation + (Number(best.saturation) || 0) / 100 * weight * (best.saturation >= 0 ? 1 - saturation : saturation), 0, 1);
        lightness = clamp(lightness + (Number(best.luminance) || 0) / 100 * weight * (best.luminance >= 0 ? 1 - lightness : lightness), 0, 1);
        const rgb = hslToRgb(hue, saturation, lightness);
        pixels[index] = rgb[0] * 255; pixels[index + 1] = rgb[1] * 255; pixels[index + 2] = rgb[2] * 255;
    }
    return pixels;
}

function sampleBilinear(source, width, height, x, y, channel) {
    x = clamp(x, 0, width - 1); y = clamp(y, 0, height - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const tx = x - x0, ty = y - y0;
    const a = source[(y0 * width + x0) * 4 + channel] * (1 - tx) + source[(y0 * width + x1) * 4 + channel] * tx;
    const b = source[(y1 * width + x0) * 4 + channel] * (1 - tx) + source[(y1 * width + x1) * 4 + channel] * tx;
    return a * (1 - ty) + b * ty;
}

function applyOpticalCorrectionGpu(pixels, width, height, distortion, vignette, chromaticAberration) {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const bend = clamp(Number(distortion) || 0, -100, 100) / 100 * 0.34;
    const vignetteAmount = clamp(Number(vignette) || 0, -100, 100) / 100;
    const fringe = clamp(Number(chromaticAberration) || 0, -100, 100) / 100 * 0.004;
    if (bend === 0 && vignetteAmount === 0 && fringe === 0) return null;
    try {
        const canvas = new OffscreenCanvas(width, height);
        const gl = canvas.getContext('webgl2', {alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true});
        if (!gl || width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return null;
        const compile = (type, source) => {
            const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Shader invalide');
            return shader;
        };
        const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
            in vec2 position; in vec2 texCoord; out vec2 uv;
            void main(){ uv=texCoord; gl_Position=vec4(position,0.0,1.0); }`);
        const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
            precision highp float; uniform sampler2D image; uniform float bend; uniform float vignette; uniform float fringe;
            in vec2 uv; out vec4 color;
            void main(){
                vec2 centered=uv-0.5; float r2=dot(centered,centered)*4.0;
                vec2 sampleUv=0.5+centered*(1.0+bend*r2); vec2 direction=normalize(centered+vec2(0.000001)); vec2 offset=direction*fringe;
                float red=texture(image,clamp(sampleUv+offset,0.0,1.0)).r; float green=texture(image,clamp(sampleUv,0.0,1.0)).g; float blue=texture(image,clamp(sampleUv-offset,0.0,1.0)).b;
                float gain=clamp(1.0+vignette*r2*0.62,0.35,1.8); color=vec4(vec3(red,green,blue)*gain,1.0);
            }`);
        const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
        gl.useProgram(program);
        const vertices = new Float32Array([-1,-1,0,0, 1,-1,1,0, -1,1,0,1, 1,1,1,1]);
        const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        for (const [name, offset] of [['position', 0], ['texCoord', 8]]) {
            const location = gl.getAttribLocation(program, name); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 16, offset);
        }
        const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.uniform1i(gl.getUniformLocation(program, 'image'), 0); gl.uniform1f(gl.getUniformLocation(program, 'bend'), bend);
        gl.uniform1f(gl.getUniformLocation(program, 'vignette'), vignetteAmount); gl.uniform1f(gl.getUniformLocation(program, 'fringe'), fringe);
        gl.viewport(0, 0, width, height); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const output = new Uint8ClampedArray(pixels.length); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, output);
        return output;
    } catch (_) {
        return null;
    }
}

function applyOpticalCorrectionCpu(pixels, width, height, distortion, vignette, chromaticAberration) {
    const bend = clamp(Number(distortion) || 0, -100, 100) / 100 * 0.34;
    const vignetteAmount = clamp(Number(vignette) || 0, -100, 100) / 100;
    const fringe = clamp(Number(chromaticAberration) || 0, -100, 100) / 100 * Math.min(width, height) * 0.004;
    if (bend === 0 && vignetteAmount === 0 && fringe === 0) return pixels;
    const source = new Uint8ClampedArray(pixels), output = new Uint8ClampedArray(pixels.length);
    const halfWidth = width / 2, halfHeight = height / 2;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const nx = (x - halfWidth) / halfWidth, ny = (y - halfHeight) / halfHeight;
        const radiusSquared = nx * nx + ny * ny;
        const factor = 1 + bend * radiusSquared;
        const sampleX = halfWidth + nx * factor * halfWidth, sampleY = halfHeight + ny * factor * halfHeight;
        const length = Math.max(0.001, Math.hypot(nx, ny));
        const offsetX = nx / length * fringe, offsetY = ny / length * fringe;
        const target = (y * width + x) * 4;
        const gain = clamp(1 + vignetteAmount * radiusSquared * 0.62, 0.35, 1.8);
        output[target] = sampleBilinear(source, width, height, sampleX + offsetX, sampleY + offsetY, 0) * gain;
        output[target + 1] = sampleBilinear(source, width, height, sampleX, sampleY, 1) * gain;
        output[target + 2] = sampleBilinear(source, width, height, sampleX - offsetX, sampleY - offsetY, 2) * gain;
        output[target + 3] = 255;
    }
    return output;
}

function applyLocalAdjustments(pixels, mask, exposure, saturation) {
    if (!mask?.some(value => value !== 0)) return pixels;
    const adjusted = new Uint8ClampedArray(pixels);
    applyBasicAdjustments(adjusted, exposure, 0, 0, 0);
    applySaturation(adjusted, saturation);
    for (let pixel = 0; pixel < mask.length; pixel++) {
        const amount = mask[pixel] / 255;
        if (amount === 0) continue;
        const index = pixel * 4;
        for (let channel = 0; channel < 3; channel++) pixels[index + channel] += (adjusted[index + channel] - pixels[index + channel]) * amount;
    }
    return pixels;
}

function buildRgbHistogram(pixels) {
    const result = {red: Array(256).fill(0), green: Array(256).fill(0), blue: Array(256).fill(0), luma: Array(256).fill(0)};
    const stride = Math.max(1, Math.floor((pixels.length / 4) / 280000));
    for (let index = 0; index < pixels.length; index += 4 * stride) {
        const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
        result.red[red]++; result.green[green]++; result.blue[blue]++;
        result.luma[Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722)]++;
    }
    return result;
}

function isNeutralDevelopment(settings, maskBuffer, localMaskBuffer) {
    if ((settings.preset || 'none') !== 'none' || maskBuffer || localMaskBuffer) return false;
    if (settings.toneCurve && settings.toneCurve !== 'linear') return false;
    const numericSettings = ['denoise', 'dehaze', 'saturation', 'highlights', 'shadows', 'exposure', 'contrast', 'whites', 'blacks', 'temperature', 'tint', 'vibrance', 'clarity', 'sharpening', 'lensDistortion', 'lensVignette', 'chromaticAberration', 'localExposure', 'localSaturation'];
    if (numericSettings.some(key => Number(settings[key]) !== 0)) return false;
    return Object.values(settings.hslMixer || {}).every(values => !values || (!Number(values.hue) && !Number(values.saturation) && !Number(values.luminance)));
}

function applyTonalAdjustments(pixels, highlights, shadows) {
    const highlightAmount = clamp(Number(highlights) || 0, -100, 100) / 100;
    const shadowAmount = clamp(Number(shadows) || 0, -100, 100) / 100;
    if (highlightAmount === 0 && shadowAmount === 0) return pixels;

    for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index] / 255;
        const green = pixels[index + 1] / 255;
        const blue = pixels[index + 2] / 255;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        const highlightMask = luminance * luminance;
        const shadowMask = (1 - luminance) * (1 - luminance);

        for (let channel = 0; channel < 3; channel++) {
            let value = pixels[index + channel] / 255;
            if (shadowAmount >= 0) value += (1 - value) * shadowAmount * shadowMask * 0.68;
            else value += value * shadowAmount * shadowMask * 0.68;
            if (highlightAmount >= 0) value += (1 - value) * highlightAmount * highlightMask * 0.68;
            else value += value * highlightAmount * highlightMask * 0.68;
            pixels[index + channel] = clamp(value * 255, 0, 255);
        }
    }
    return pixels;
}

function inpaintMask(pixels, width, height, mask) {
    if (!mask?.some(value => value !== 0)) return pixels;
    const state = new Uint8Array(mask);
    const originalMask = new Uint8Array(mask);
    const source = new Uint8ClampedArray(pixels);
    const maskedCount = originalMask.reduce((total, value) => total + (value ? 1 : 0), 0);
    const maximumSearch = clamp(Math.round(Math.sqrt(maskedCount) * 0.72), 10, 110);
    const oppositeDirections = [[[1,0],[-1,0]], [[0,1],[0,-1]], [[1,1],[-1,-1]], [[1,-1],[-1,1]]];
    const knownSample = (x, y, dx, dy) => {
        for (let distance = 1; distance <= maximumSearch; distance++) {
            const sampleX = x + dx * distance, sampleY = y + dy * distance;
            if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) return null;
            const pixel = sampleY * width + sampleX;
            if (!originalMask[pixel]) return {pixel, distance, x: sampleX, y: sampleY};
        }
        return null;
    };
    const colorDistance = (first, second) => {
        const a = first.pixel * 4, b = second.pixel * 4;
        const red = source[a] - source[b], green = source[a + 1] - source[b + 1], blue = source[a + 2] - source[b + 2];
        return red * red * 0.24 + green * green * 0.62 + blue * blue * 0.14;
    };
    const localMean = (sample, channel) => {
        let total = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const x = clamp(sample.x + dx, 0, width - 1), y = clamp(sample.y + dy, 0, height - 1);
            const pixel = y * width + x;
            if (originalMask[pixel]) continue;
            total += source[pixel * 4 + channel]; count++;
        }
        return count ? total / count : source[sample.pixel * 4 + channel];
    };

    // Reconstitue d'abord les lignes et les contours depuis deux bords opposés.
    // Cette étape conserve mieux les textures qu'une simple moyenne propagée.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            if (!originalMask[pixel]) continue;
            let best = null;
            for (const [forward, backward] of oppositeDirections) {
                const first = knownSample(x, y, forward[0], forward[1]);
                const second = knownSample(x, y, backward[0], backward[1]);
                if (!first || !second) continue;
                const score = colorDistance(first, second) + (first.distance + second.distance) * 0.45;
                if (!best || score < best.score) best = {first, second, score};
            }
            if (!best) continue;
            const target = pixel * 4;
            const totalDistance = best.first.distance + best.second.distance;
            const firstWeight = best.second.distance / totalDistance;
            const secondWeight = best.first.distance / totalDistance;
            const textureSample = best.first.distance <= best.second.distance ? best.first : best.second;
            for (let channel = 0; channel < 3; channel++) {
                const firstValue = source[best.first.pixel * 4 + channel];
                const secondValue = source[best.second.pixel * 4 + channel];
                const interpolation = firstValue * firstWeight + secondValue * secondWeight;
                const texture = source[textureSample.pixel * 4 + channel] - localMean(textureSample, channel);
                pixels[target + channel] = clamp(interpolation + texture * 0.58, 0, 255);
            }
            pixels[target + 3] = source[target + 3];
            state[pixel] = 0;
        }
    }

    const queued = new Uint8Array(mask.length);
    const queue = [];
    const neighbors = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
    const hasKnownNeighbor = (x, y) => neighbors.some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && nx < width && ny >= 0 && ny < height && state[ny * width + nx] === 0;
    });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            if (state[pixel] && hasKnownNeighbor(x, y)) {
                queue.push(pixel);
                queued[pixel] = 1;
            }
        }
    }
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const pixel = queue[cursor];
        if (state[pixel] === 0) continue;
        const x = pixel % width, y = Math.floor(pixel / width);
        let red = 0, green = 0, blue = 0, total = 0;
        for (const [dx, dy] of neighbors) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const neighborPixel = ny * width + nx;
            if (state[neighborPixel] !== 0) continue;
            const index = neighborPixel * 4;
            const weight = dx === 0 || dy === 0 ? 1.4 : 1;
            red += pixels[index] * weight;
            green += pixels[index + 1] * weight;
            blue += pixels[index + 2] * weight;
            total += weight;
        }
        if (total === 0) continue;
        const target = pixel * 4;
        pixels[target] = red / total;
        pixels[target + 1] = green / total;
        pixels[target + 2] = blue / total;
        state[pixel] = 0;
        for (const [dx, dy] of neighbors) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const neighborPixel = ny * width + nx;
            if (state[neighborPixel] && !queued[neighborPixel]) {
                queue.push(neighborPixel);
                queued[neighborPixel] = 1;
            }
        }
    }
    return pixels;
}

function detectDustSpots(pixels, width, height) {
    const shortEdge = Math.min(width, height);
    const stride = shortEdge > 700 ? 2 : 1;
    const radii = [...new Set([
        clamp(Math.round(shortEdge / 310), 2, 6),
        clamp(Math.round(shortEdge / 190), 4, 10),
    ])];
    const candidates = [];
    const luma = new Float32Array(width * height);
    const chromaBlue = new Float32Array(width * height);
    const chromaRed = new Float32Array(width * height);
    for (let pixel = 0, index = 0; pixel < luma.length; pixel++, index += 4) {
        const value = pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
        luma[pixel] = value;
        chromaBlue[pixel] = pixels[index + 2] - value;
        chromaRed[pixel] = pixels[index] - value;
    }
    const integral = new Float64Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y++) {
        let rowTotal = 0;
        for (let x = 0; x < width; x++) {
            rowTotal += luma[y * width + x];
            integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + rowTotal;
        }
    }
    const boxMean = (x, y, radius) => {
        const left = Math.max(0, x - radius), right = Math.min(width - 1, x + radius);
        const top = Math.max(0, y - radius), bottom = Math.min(height - 1, y + radius);
        const total = integral[(bottom + 1) * (width + 1) + right + 1] - integral[top * (width + 1) + right + 1]
            - integral[(bottom + 1) * (width + 1) + left] + integral[top * (width + 1) + left];
        return total / ((right - left + 1) * (bottom - top + 1));
    };
    const sampleAt = (array, x, y) => array[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
    const directions = Array.from({length: 16}, (_, index) => {
        const angle = index * Math.PI / 8;
        return [Math.cos(angle), Math.sin(angle)];
    });

    for (const radius of radii) {
        const margin = radius * 3 + 2;
        for (let y = margin; y < height - margin; y += stride) {
            for (let x = margin; x < width - margin; x += stride) {
                const centerPixel = y * width + x;
                const center = luma[centerPixel];
                if (center < 8 || center > 242) continue;
                const innerMean = boxMean(x, y, Math.max(1, Math.round(radius * 0.55)));
                let ringMean = 0, ringSquare = 0, ringBlue = 0, ringRed = 0, ringBlueSquare = 0, ringRedSquare = 0, texture = 0;
                const radialDarkness = [];
                for (const [directionX, directionY] of directions) {
                    const ringX = Math.round(x + directionX * radius * 2.15);
                    const ringY = Math.round(y + directionY * radius * 2.15);
                    const ringPixel = ringY * width + ringX;
                    const value = luma[ringPixel];
                    ringMean += value;
                    ringSquare += value * value;
                    ringBlue += chromaBlue[ringPixel];
                    ringRed += chromaRed[ringPixel];
                    ringBlueSquare += chromaBlue[ringPixel] ** 2;
                    ringRedSquare += chromaRed[ringPixel] ** 2;
                    texture += Math.abs(value - (
                        sampleAt(luma, ringX - 1, ringY) + sampleAt(luma, ringX + 1, ringY)
                        + sampleAt(luma, ringX, ringY - 1) + sampleAt(luma, ringX, ringY + 1)
                    ) * 0.25);
                    radialDarkness.push(value - sampleAt(luma, Math.round(x + directionX * radius * 0.7), Math.round(y + directionY * radius * 0.7)));
                }
                ringMean /= directions.length;
                ringBlue /= directions.length;
                ringRed /= directions.length;
                texture /= directions.length;
                const ringDeviation = Math.sqrt(Math.max(0, ringSquare / directions.length - ringMean * ringMean));
                const ringColorDeviation = Math.sqrt(
                    Math.max(0, ringBlueSquare / directions.length - ringBlue * ringBlue)
                    + Math.max(0, ringRedSquare / directions.length - ringRed * ringRed)
                );
                const darkness = ringMean - innerMean;
                const coreDarkness = innerMean - center;
                if (darkness < Math.max(4.5, texture * 1.8 + 2.5)) continue;
                if (coreDarkness < Math.max(0.7, darkness * 0.05)) continue;
                if (ringDeviation > Math.max(8, darkness * 1.15)) continue;
                if (ringColorDeviation > Math.max(5, darkness * 0.42)) continue;
                const horizontalGradient = Math.abs(sampleAt(luma, x + radius, y) - sampleAt(luma, x - radius, y));
                const verticalGradient = Math.abs(sampleAt(luma, x, y + radius) - sampleAt(luma, x, y - radius));
                if (Math.hypot(horizontalGradient, verticalGradient) > Math.max(16, darkness * 2.1)) continue;
                const radialMean = radialDarkness.reduce((sum, value) => sum + value, 0) / radialDarkness.length;
                const radialDeviation = Math.sqrt(radialDarkness.reduce((sum, value) => sum + (value - radialMean) ** 2, 0) / radialDarkness.length);
                if (radialDeviation > Math.max(4.5, darkness * 0.7)) continue;
                const chromaShift = Math.hypot(chromaBlue[centerPixel] - ringBlue, chromaRed[centerPixel] - ringRed);
                if (chromaShift > Math.max(7, darkness * 0.9)) continue;
                const score = darkness + coreDarkness * 0.35 - ringDeviation * 0.32 - ringColorDeviation * 0.3 - radialDeviation * 0.45 - texture * 0.8 - chromaShift * 0.18;
                if (score > 1.5) candidates.push({x, y, radius, score});
            }
        }
    }
    candidates.sort((a, b) => b.score - a.score);
    const selected = [];
    for (const candidate of candidates) {
        if (selected.some(spot => Math.hypot(spot.x - candidate.x, spot.y - candidate.y) < Math.max(spot.radius, candidate.radius) * 2.8)) continue;
        selected.push(candidate);
        if (selected.length >= 40) break;
    }
    return selected.map(spot => ({x: spot.x / width, y: spot.y / height, radius: spot.radius * 1.6 / shortEdge}));
}

self.onmessage = event => {
    const {id, action, width, height, buffer, maskBuffer, localMaskBuffer, settings} = event.data;
    try {
        let pixels = new Uint8ClampedArray(buffer);
        if (action === 'detectDust') {
            self.postMessage({id, spots: detectDustSpots(pixels, width, height)});
            return;
        }
        if (isNeutralDevelopment(settings, maskBuffer, localMaskBuffer)) {
            const histogram = buildRgbHistogram(pixels);
            self.postMessage({id, width, height, buffer: pixels.buffer, histogram, accelerator: 'cpu', neutral: true}, [pixels.buffer]);
            return;
        }
        const denoise = clamp(Number(settings.denoise) || 0, 0, 3);
        if (denoise > 0) {
            pixels = denoisePass(pixels, width, height, denoise, settings);
            self.postMessage({id, progress: 58});
        }
        const automaticBase = new Uint8ClampedArray(pixels);
        pixels = applyLook(pixels, settings.preset || 'natural');
        pixels = blendAutomaticLook(automaticBase, pixels, settings.autoStrength ?? 100);
        pixels = applyWhiteBalance(pixels, settings.temperature, settings.tint);
        pixels = applyBasicAdjustments(pixels, settings.exposure, settings.contrast, settings.whites, settings.blacks);
        pixels = applyToneCurve(pixels, settings.toneCurve);
        pixels = applyDehaze(pixels, settings.dehaze);
        pixels = applyVibrance(pixels, settings.vibrance);
        pixels = applySaturation(pixels, settings.saturation);
        pixels = applyHslMixer(pixels, settings.hslMixer);
        pixels = applyTonalAdjustments(pixels, settings.highlights, settings.shadows);
        pixels = applyLocalDetail(pixels, width, height, settings.clarity, settings.sharpening);
        if (localMaskBuffer) pixels = applyLocalAdjustments(pixels, new Uint8Array(localMaskBuffer), settings.localExposure, settings.localSaturation);
        if (maskBuffer) pixels = inpaintMask(pixels, width, height, new Uint8Array(maskBuffer));
        const opticalRequested = Boolean(Number(settings.lensDistortion) || Number(settings.lensVignette) || Number(settings.chromaticAberration));
        const gpuPixels = opticalRequested ? applyOpticalCorrectionGpu(pixels, width, height, settings.lensDistortion, settings.lensVignette, settings.chromaticAberration) : null;
        const accelerator = gpuPixels ? 'webgl2' : 'cpu';
        pixels = gpuPixels || applyOpticalCorrectionCpu(pixels, width, height, settings.lensDistortion, settings.lensVignette, settings.chromaticAberration);
        const histogram = buildRgbHistogram(pixels);
        self.postMessage({id, progress: 96});
        self.postMessage({id, width, height, buffer: pixels.buffer, histogram, accelerator}, [pixels.buffer]);
    } catch (error) {
        self.postMessage({id, error: error instanceof Error ? error.message : 'Traitement impossible'});
    }
};
