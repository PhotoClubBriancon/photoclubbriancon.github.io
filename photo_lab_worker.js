'use strict';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

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

function analyze(pixels) {
    const histogram = new Uint32Array(256);
    const pixelCount = pixels.length / 4;
    const stride = Math.max(1, Math.floor(pixelCount / 220000));
    let red = 0, green = 0, blue = 0, samples = 0;
    for (let pixel = 0; pixel < pixelCount; pixel += stride) {
        const index = pixel * 4;
        if (pixels[index + 3] < 16) continue;
        const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
        histogram[Math.round(r * 0.2126 + g * 0.7152 + b * 0.0722)]++;
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
    return {
        black: percentile(0.008),
        white: percentile(0.992),
        red: red / Math.max(1, samples),
        green: green / Math.max(1, samples),
        blue: blue / Math.max(1, samples),
        mean: histogram.reduce((sum, count, value) => sum + count * value, 0) / Math.max(1, samples),
    };
}

function applyLook(pixels, preset) {
    if (preset === 'none') return pixels;
    const stats = analyze(pixels);
    const dynamic = preset === 'dynamic' || preset === 'bw-contrast';
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
        const channels = [
            clamp((pixels[index] * gains[0] - black) / range, 0, 1),
            clamp((pixels[index + 1] * gains[1] - black) / range, 0, 1),
            clamp((pixels[index + 2] * gains[2] - black) / range, 0, 1),
        ].map(value => clamp((Math.pow(value, gamma) - 0.5) * contrast + 0.5, 0, 1));
        const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        if (monochrome) {
            const gray = clamp(luminance * 255, 0, 255);
            pixels[index] = gray; pixels[index + 1] = gray; pixels[index + 2] = gray;
        } else {
            pixels[index] = clamp((luminance + (channels[0] - luminance) * saturation) * 255, 0, 255);
            pixels[index + 1] = clamp((luminance + (channels[1] - luminance) * saturation) * 255, 0, 255);
            pixels[index + 2] = clamp((luminance + (channels[2] - luminance) * saturation) * 255, 0, 255);
        }
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
        pixels = applyLook(pixels, settings.preset || 'natural');
        pixels = applyTonalAdjustments(pixels, settings.highlights, settings.shadows);
        self.postMessage({id, progress: 96});
        self.postMessage({id, width, height, buffer: pixels.buffer}, [pixels.buffer]);
    } catch (error) {
        self.postMessage({id, error: error instanceof Error ? error.message : 'Traitement impossible'});
    }
};
