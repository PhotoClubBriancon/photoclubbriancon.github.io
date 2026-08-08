'use strict';

(() => {
    const root = document.getElementById('photoLab');
    if (!root) return;

    const input = document.getElementById('photoLabInput');
    const drop = document.getElementById('photoLabDrop');
    const workspace = document.getElementById('photoLabWorkspace');
    const originalCanvas = document.getElementById('photoLabOriginal');
    const processedCanvas = document.getElementById('photoLabProcessed');
    const compare = document.getElementById('photoLabCompare');
    const divider = document.getElementById('photoLabDivider');
    const denoise = document.getElementById('photoLabDenoise');
    const denoiseValue = document.getElementById('photoLabDenoiseValue');
    const quality = document.getElementById('photoLabQuality');
    const qualityValue = document.getElementById('photoLabQualityValue');
    const format = document.getElementById('photoLabFormat');
    const download = document.getElementById('photoLabDownload');
    const clear = document.getElementById('photoLabClear');
    const status = document.getElementById('photoLabStatus');
    const progress = document.getElementById('photoLabProgress');
    const progressBar = progress.querySelector('span');

    let sourceFile = null;
    let sourceBitmap = null;
    let preset = 'natural';
    let requestSequence = 0;
    let previewGeneration = 0;
    let previewTimer = 0;
    const pending = new Map();
    const worker = new Worker('/photo_lab_worker.js');

    const denoiseLabels = ['Aucun', 'Léger', 'Moyen', 'Fort'];
    const suffixes = {natural: 'auto-naturel', dynamic: 'auto-dynamique', bw: 'noir-blanc', 'bw-contrast': 'noir-blanc-contraste', none: 'original'};

    function setStatus(message, error = false) {
        status.textContent = message;
        status.style.color = error ? '#ff8c86' : 'var(--text-dim)';
    }

    function setProgress(value, visible = true) {
        progress.style.display = visible ? 'block' : 'none';
        progressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
    }

    worker.onmessage = event => {
        const message = event.data;
        const task = pending.get(message.id);
        if (!task) return;
        if (typeof message.progress === 'number') {
            task.onProgress?.(message.progress);
            return;
        }
        pending.delete(message.id);
        if (message.error) task.reject(new Error(message.error));
        else task.resolve(new ImageData(new Uint8ClampedArray(message.buffer), message.width, message.height));
    };

    worker.onerror = () => {
        for (const task of pending.values()) task.reject(new Error('Le moteur de traitement ne répond pas.'));
        pending.clear();
    };

    function processImageData(imageData, onProgress) {
        const id = ++requestSequence;
        const settings = {preset, denoise: Number(denoise.value)};
        return new Promise((resolve, reject) => {
            pending.set(id, {resolve, reject, onProgress});
            worker.postMessage({
                id,
                width: imageData.width,
                height: imageData.height,
                buffer: imageData.data.buffer,
                settings,
            }, [imageData.data.buffer]);
        });
    }

    function scaleWithin(width, height, maximum) {
        const ratio = Math.min(1, maximum / Math.max(width, height));
        return [Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio))];
    }

    function drawBitmap(canvas, width, height) {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(sourceBitmap, 0, 0, width, height);
        return context;
    }

    async function updatePreview() {
        if (!sourceBitmap) return;
        const generation = ++previewGeneration;
        setStatus('Calcul de l’aperçu…');
        setProgress(8);
        try {
            const context = originalCanvas.getContext('2d', {alpha: false, willReadFrequently: true});
            const original = context.getImageData(0, 0, originalCanvas.width, originalCanvas.height);
            const result = await processImageData(original, value => setProgress(value));
            if (generation !== previewGeneration) return;
            processedCanvas.width = result.width;
            processedCanvas.height = result.height;
            processedCanvas.getContext('2d', {alpha: false}).putImageData(result, 0, 0);
            setProgress(100);
            window.setTimeout(() => setProgress(0, false), 300);
            setStatus(`Aperçu prêt · ${sourceBitmap.width} × ${sourceBitmap.height} px`);
        } catch (error) {
            setProgress(0, false);
            setStatus(error.message || 'Aperçu impossible.', true);
        }
    }

    function schedulePreview() {
        window.clearTimeout(previewTimer);
        previewTimer = window.setTimeout(updatePreview, 140);
    }

    async function openFile(file) {
        if (!file) return;
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            setStatus('Format non pris en charge. Utilisez JPEG, PNG ou WebP.', true);
            return;
        }
        if (file.size > 60 * 1024 * 1024) {
            setStatus('La photographie dépasse la limite de 60 Mo.', true);
            return;
        }
        setStatus('Ouverture de la photographie…');
        try {
            sourceBitmap?.close?.();
            sourceBitmap = await createImageBitmap(file, {imageOrientation: 'from-image'});
            if (sourceBitmap.width * sourceBitmap.height > 50000000) {
                sourceBitmap.close?.(); sourceBitmap = null;
                throw new Error('La photographie dépasse la limite de 50 mégapixels.');
            }
            sourceFile = file;
            const [width, height] = scaleWithin(sourceBitmap.width, sourceBitmap.height, 1400);
            drawBitmap(originalCanvas, width, height);
            processedCanvas.width = width;
            processedCanvas.height = height;
            processedCanvas.getContext('2d').drawImage(originalCanvas, 0, 0);
            workspace.style.display = 'block';
            drop.style.display = 'none';
            await updatePreview();
        } catch (error) {
            setStatus(error.message || 'Impossible de lire cette photographie.', true);
        }
    }

    function outputExtension(mime) {
        return mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
    }

    async function downloadResult() {
        if (!sourceBitmap || !sourceFile) return;
        download.disabled = true;
        setStatus('Préparation de la version 4K…');
        setProgress(3);
        try {
            const [width, height] = scaleWithin(sourceBitmap.width, sourceBitmap.height, 3840);
            const canvas = document.createElement('canvas');
            const context = drawBitmap(canvas, width, height);
            const original = context.getImageData(0, 0, width, height);
            const result = await processImageData(original, value => setProgress(value));
            context.putImageData(result, 0, 0);
            setStatus('Encodage du fichier…');
            setProgress(98);
            const mime = format.value;
            const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, Number(quality.value) / 100));
            if (!blob) throw new Error('Votre navigateur ne peut pas créer ce format.');
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            const baseName = sourceFile.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'photo';
            anchor.href = url;
            anchor.download = `${baseName}-${suffixes[preset] || 'traitee'}-${width}x${height}.${outputExtension(mime)}`;
            anchor.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1500);
            setProgress(100);
            const megabytes = (blob.size / 1024 / 1024).toFixed(2).replace('.', ',');
            setStatus(`Téléchargement prêt · ${width} × ${height} px · ${megabytes} Mo`);
            window.setTimeout(() => setProgress(0, false), 500);
        } catch (error) {
            setProgress(0, false);
            setStatus(error.message || 'Export impossible.', true);
        } finally {
            download.disabled = false;
        }
    }

    function clearFile() {
        sourceBitmap?.close?.();
        sourceBitmap = null;
        sourceFile = null;
        input.value = '';
        workspace.style.display = 'none';
        drop.style.display = 'block';
        setProgress(0, false);
        setStatus('Choisissez une photographie.');
    }

    input.addEventListener('change', event => openFile(event.target.files?.[0]));
    for (const eventName of ['dragenter', 'dragover']) {
        drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.add('dragover'); });
    }
    for (const eventName of ['dragleave', 'drop']) {
        drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.remove('dragover'); });
    }
    drop.addEventListener('drop', event => openFile(event.dataTransfer?.files?.[0]));
    compare.addEventListener('input', () => {
        processedCanvas.style.clipPath = `inset(0 0 0 ${compare.value}%)`;
        divider.style.left = `${compare.value}%`;
    });
    denoise.addEventListener('input', () => { denoiseValue.value = denoiseLabels[Number(denoise.value)]; schedulePreview(); });
    quality.addEventListener('input', () => { qualityValue.value = `${quality.value} %`; });
    format.addEventListener('change', () => { quality.disabled = format.value === 'image/png'; });
    root.querySelectorAll('[data-photo-preset]').forEach(button => button.addEventListener('click', () => {
        preset = button.dataset.photoPreset;
        root.querySelectorAll('[data-photo-preset]').forEach(candidate => candidate.classList.toggle('active', candidate === button));
        if (preset === 'none') {
            denoise.value = '0';
            denoiseValue.value = denoiseLabels[0];
        }
        schedulePreview();
    }));
    download.addEventListener('click', downloadResult);
    clear.addEventListener('click', clearFile);
})();
