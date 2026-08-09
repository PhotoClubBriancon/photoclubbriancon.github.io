'use strict';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const smoothstep = (edge0, edge1, value) => {
    const position = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
    return position * position * (3 - 2 * position);
};

function denoisePass(source, width, height, threshold) {
    const output = new Uint8ClampedArray(source.length);
    const weights = [1, 2, 1, 2, 4, 2, 1, 2, 1];
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
                    if (difference > threshold && sampleIndex !== centerIndex) continue;
                    const rangeWeight = 1 - Math.min(0.78, difference / Math.max(1, threshold) * 0.65);
                    const weight = weights[weightIndex] * rangeWeight;
                    red += source[sampleIndex] * weight;
                    green += source[sampleIndex + 1] * weight;
                    blue += source[sampleIndex + 2] * weight;
                    total += weight;
                }
            }
            output[centerIndex] = red / total;
            output[centerIndex + 1] = green / total;
            output[centerIndex + 2] = blue / total;
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
    const dynamic = preset === 'dynamic' || preset === 'bw-contrast' || silhouette;
    const monochrome = preset === 'bw' || preset === 'bw-contrast';
    const neutral = (stats.red + stats.green + stats.blue) / 3;
    const balanceLimit = dynamic ? [0.76, 1.24] : [0.84, 1.16];
    const gains = [stats.red, stats.green, stats.blue].map(channel => clamp(neutral / Math.max(1, channel), balanceLimit[0], balanceLimit[1]));
    const black = Math.min(24, stats.black);
    const white = Math.max(178, stats.white);
    const range = Math.max(80, white - black);
    const normalizedMean = clamp((stats.mean - black) / range, 0.08, 0.92);
    const target = dynamic ? 0.51 : 0.48;
    const gamma = clamp(Math.log(target) / Math.log(normalizedMean), 0.72, 1.32);
    const contrast = preset === 'bw-contrast' ? 1.22 : (dynamic ? 1.12 : 1.04);
    const saturation = monochrome ? 0 : (dynamic ? 1.12 : 1.04);

    for (let index = 0; index < pixels.length; index += 4) {
        const originalChannels = [pixels[index] / 255, pixels[index + 1] / 255, pixels[index + 2] / 255];
        const originalLuminance = originalChannels[0] * 0.2126 + originalChannels[1] * 0.7152 + originalChannels[2] * 0.0722;
        const channels = [
            clamp((pixels[index] * gains[0] - black) / range, 0, 1),
            clamp((pixels[index + 1] * gains[1] - black) / range, 0, 1),
            clamp((pixels[index + 2] * gains[2] - black) / range, 0, 1),
        ].map(value => clamp((Math.pow(value, gamma) - 0.5) * contrast + 0.5, 0, 1));
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
                const treated = clamp(luminance + (channels[channel] - luminance) * saturation, 0, 1);
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

self.onmessage = event => {
    const {id, width, height, buffer, settings} = event.data;
    try {
        let pixels = new Uint8ClampedArray(buffer);
        const denoise = clamp(Number(settings.denoise) || 0, 0, 3);
        const thresholds = [0, 18, 28, 40];
        for (let pass = 0; pass < denoise; pass++) {
            pixels = denoisePass(pixels, width, height, thresholds[denoise]);
            self.postMessage({id, progress: Math.round((pass + 1) / (denoise + 1) * 78)});
        }
        const automaticBase = new Uint8ClampedArray(pixels);
        pixels = applyLook(pixels, settings.preset || 'natural');
        pixels = blendAutomaticLook(automaticBase, pixels, settings.autoStrength ?? 100);
        pixels = applyDehaze(pixels, settings.dehaze);
        pixels = applySaturation(pixels, settings.saturation);
        pixels = applyTonalAdjustments(pixels, settings.highlights, settings.shadows);
        self.postMessage({id, progress: 96});
        self.postMessage({id, width, height, buffer: pixels.buffer}, [pixels.buffer]);
    } catch (error) {
        self.postMessage({id, error: error instanceof Error ? error.message : 'Traitement impossible'});
    }
};
