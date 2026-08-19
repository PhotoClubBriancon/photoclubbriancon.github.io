'use strict';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const smoothstep = (edge0, edge1, value) => {
    const position = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
    return position * position * (3 - 2 * position);
};

function denoisePass(source, width, height, strength) {
    const output = new Uint8ClampedArray(source.length);
    const weights = [1, 2, 1, 2, 4, 2, 1, 2, 1];
    const thresholds = [0, 11, 18, 27];
    const chromaAmounts = [0, 0.34, 0.5, 0.64];
    const lumaAmounts = [0, 0.1, 0.17, 0.24];
    const threshold = thresholds[strength];
    const rangeWeights = new Float32Array(256);
    for (let difference = 0; difference < rangeWeights.length; difference++) {
        rangeWeights[difference] = Math.exp(-(difference * difference) / (2 * threshold * threshold));
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const centerIndex = (y * width + x) * 4;
            const centerLuma = source[centerIndex] * 0.2126 + source[centerIndex + 1] * 0.7152 + source[centerIndex + 2] * 0.0722;
            let red = 0, green = 0, blue = 0, total = 0, weightIndex = 0;
            for (let offsetY = -1; offsetY <= 1; offsetY++) {
                const sampleY = clamp(y + offsetY, 0, height - 1);
                for (let offsetX = -1; offsetX <= 1; offsetX++, weightIndex++) {
                    const sampleX = clamp(x + offsetX, 0, width - 1);
                    const sampleIndex = (sampleY * width + sampleX) * 4;
                    const sampleLuma = source[sampleIndex] * 0.2126 + source[sampleIndex + 1] * 0.7152 + source[sampleIndex + 2] * 0.0722;
                    const difference = Math.abs(sampleLuma - centerLuma);
                    if (difference > threshold * 2.6 && sampleIndex !== centerIndex) continue;
                    const weight = weights[weightIndex] * rangeWeights[Math.min(255, Math.round(difference))];
                    red += source[sampleIndex] * weight;
                    green += source[sampleIndex + 1] * weight;
                    blue += source[sampleIndex + 2] * weight;
                    total += weight;
                }
            }
            const filtered = [red / total, green / total, blue / total];
            const filteredLuma = filtered[0] * 0.2126 + filtered[1] * 0.7152 + filtered[2] * 0.0722;
            for (let channel = 0; channel < 3; channel++) {
                const center = source[centerIndex + channel];
                const chromaFiltered = filtered[channel] + centerLuma - filteredLuma;
                let value = center + (chromaFiltered - center) * chromaAmounts[strength];
                value += (filteredLuma - centerLuma) * lumaAmounts[strength];
                output[centerIndex + channel] = clamp(value, 0, 255);
            }
            output[centerIndex + 3] = source[centerIndex + 3];
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
    const radius = clamp(Math.round(shortEdge / 230), 3, 9);
    const stride = shortEdge > 700 ? 2 : 1;
    const candidates = [];
    const lumaAt = (x, y) => {
        const index = (y * width + x) * 4;
        return pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
    };
    const ring = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
    for (let y = radius + 1; y < height - radius - 1; y += stride) {
        for (let x = radius + 1; x < width - radius - 1; x += stride) {
            const center = lumaAt(x, y);
            if (center < 5 || center > 235) continue;
            const samples = ring.map(([dx, dy]) => lumaAt(x + dx * radius, y + dy * radius));
            const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
            const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
            const darkness = mean - center;
            if (darkness < 13 || variance > 115) continue;
            if (center > lumaAt(x - 1, y) || center > lumaAt(x + 1, y) || center > lumaAt(x, y - 1) || center > lumaAt(x, y + 1)) continue;
            candidates.push({x, y, score: darkness - Math.sqrt(variance) * 0.35});
        }
    }
    candidates.sort((a, b) => b.score - a.score);
    const selected = [];
    const minimumDistance = radius * 2.8;
    for (const candidate of candidates) {
        if (selected.some(spot => Math.hypot(spot.x - candidate.x, spot.y - candidate.y) < minimumDistance)) continue;
        selected.push(candidate);
        if (selected.length >= 80) break;
    }
    return selected.map(spot => ({x: spot.x / width, y: spot.y / height, radius: radius * 1.45 / shortEdge}));
}

self.onmessage = event => {
    const {id, action, width, height, buffer, maskBuffer, settings} = event.data;
    try {
        let pixels = new Uint8ClampedArray(buffer);
        if (action === 'detectDust') {
            self.postMessage({id, spots: detectDustSpots(pixels, width, height)});
            return;
        }
        const denoise = clamp(Number(settings.denoise) || 0, 0, 3);
        if (denoise > 0) {
            pixels = denoisePass(pixels, width, height, denoise);
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
        pixels = applyTonalAdjustments(pixels, settings.highlights, settings.shadows);
        pixels = applyLocalDetail(pixels, width, height, settings.clarity, settings.sharpening);
        if (maskBuffer) pixels = inpaintMask(pixels, width, height, new Uint8Array(maskBuffer));
        self.postMessage({id, progress: 96});
        self.postMessage({id, width, height, buffer: pixels.buffer}, [pixels.buffer]);
    } catch (error) {
        self.postMessage({id, error: error instanceof Error ? error.message : 'Traitement impossible'});
    }
};
