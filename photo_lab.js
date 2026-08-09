'use strict';

(() => {
    const root = document.getElementById('photoLab');
    if (!root) return;

    const byId = id => document.getElementById(id);
    const input = byId('photoLabInput');
    const drop = byId('photoLabDrop');
    const workspace = byId('photoLabWorkspace');
    const preview = byId('photoLabPreview');
    const previewStage = byId('photoLabPreviewStage');
    const originalCanvas = byId('photoLabOriginal');
    const processedCanvas = byId('photoLabProcessed');
    const compare = byId('photoLabCompare');
    const divider = byId('photoLabDivider');
    const cropOverlay = byId('photoLabCropOverlay');
    const horizonLine = byId('photoLabHorizonLine');
    const denoise = byId('photoLabDenoise');
    const denoiseValue = byId('photoLabDenoiseValue');
    const autoStrength = byId('photoLabAutoStrength');
    const autoStrengthValue = byId('photoLabAutoStrengthValue');
    const dehaze = byId('photoLabDehaze');
    const dehazeValue = byId('photoLabDehazeValue');
    const saturation = byId('photoLabSaturation');
    const saturationValue = byId('photoLabSaturationValue');
    const highlights = byId('photoLabHighlights');
    const highlightsValue = byId('photoLabHighlightsValue');
    const shadows = byId('photoLabShadows');
    const shadowsValue = byId('photoLabShadowsValue');
    const zoom = byId('photoLabZoom');
    const zoomValue = byId('photoLabZoomValue');
    const cropRatio = byId('photoLabCropRatio');
    const rotation = byId('photoLabRotation');
    const rotationValue = byId('photoLabRotationValue');
    const horizonButton = byId('photoLabHorizon');
    const cropReset = byId('photoLabCropReset');
    const cropHelp = byId('photoLabCropHelp');
    const quality = byId('photoLabQuality');
    const qualityValue = byId('photoLabQualityValue');
    const format = byId('photoLabFormat');
    const downloadCompetition = byId('photoLabDownloadCompetition');
    const downloadFull = byId('photoLabDownloadFull');
    const clear = byId('photoLabClear');
    const status = byId('photoLabStatus');
    const progress = byId('photoLabProgress');
    const progressBar = progress.querySelector('span');

    const worker = new Worker('/photo_lab_worker.js');
    const pending = new Map();
    const denoiseLabels = ['Aucun', 'Léger', 'Moyen', 'Fort'];
    const rawExtensions = new Set(['3fr', 'arw', 'cr2', 'cr3', 'dng', 'erf', 'kdc', 'mos', 'mrw', 'nef', 'nrw', 'orf', 'pef', 'raf', 'raw', 'rw2', 'sr2', 'srf']);
    const suffixes = {natural: 'auto-naturel', dynamic: 'auto-dynamique', silhouette: 'auto-silhouette', bw: 'noir-blanc', 'bw-contrast': 'noir-blanc-contraste', none: 'original'};
    const MAX_CONTEST_BYTES = Math.round(2.7 * 1024 * 1024);

    let sourceFile = null;
    let sourceBitmap = null;
    let preset = 'natural';
    let requestSequence = 0;
    let previewGeneration = 0;
    let previewTimer = 0;
    let geometryTimer = 0;
    let gridTimer = 0;
    let cropEditing = false;
    let crop = {x: 0, y: 0, width: 1, height: 1};
    let rotationDegrees = 0;
    let cropDrag = null;
    let horizonMode = false;
    let horizonStart = null;

    const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

    function setStatus(message, error = false) {
        status.textContent = message;
        status.style.color = error ? '#ff8c86' : 'var(--text-dim)';
    }

    function setProgress(value, visible = true) {
        progress.style.display = visible ? 'block' : 'none';
        progressBar.style.width = `${clamp(value, 0, 100)}%`;
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

    function currentSettings() {
        return {
            preset,
            denoise: Number(denoise.value),
            autoStrength: Number(autoStrength.value),
            dehaze: Number(dehaze.value),
            saturation: Number(saturation.value),
            highlights: Number(highlights.value),
            shadows: Number(shadows.value),
        };
    }

    function processImageData(imageData, onProgress) {
        const id = ++requestSequence;
        return new Promise((resolve, reject) => {
            pending.set(id, {resolve, reject, onProgress});
            worker.postMessage({
                id,
                width: imageData.width,
                height: imageData.height,
                buffer: imageData.data.buffer,
                settings: currentSettings(),
            }, [imageData.data.buffer]);
        });
    }

    function rotatedBounds(width, height) {
        const radians = rotationDegrees * Math.PI / 180;
        return {
            width: Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians)),
            height: Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians)),
            radians,
        };
    }

    function renderBitmap(canvas, maximum = Infinity, applyCrop = true) {
        if (!sourceBitmap) return null;
        const bounds = rotatedBounds(sourceBitmap.width, sourceBitmap.height);
        const selected = applyCrop ? crop : {x: 0, y: 0, width: 1, height: 1};
        const cropWidth = Math.max(1, bounds.width * selected.width);
        const cropHeight = Math.max(1, bounds.height * selected.height);
        const scale = Number.isFinite(maximum) ? Math.min(1, maximum / Math.max(cropWidth, cropHeight)) : 1;
        const width = Math.max(1, Math.round(cropWidth * scale));
        const height = Math.max(1, Math.round(cropHeight * scale));
        if (width * height > 65000000) throw new Error('Le résultat pleine taille dépasse 65 mégapixels. Réduisez légèrement le recadrage ou utilisez l’export concours.');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
        context.fillStyle = '#000';
        context.fillRect(0, 0, width, height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.save();
        context.scale(scale, scale);
        context.translate(-selected.x * bounds.width, -selected.y * bounds.height);
        context.translate(bounds.width / 2, bounds.height / 2);
        context.rotate(bounds.radians);
        context.drawImage(sourceBitmap, -sourceBitmap.width / 2, -sourceBitmap.height / 2);
        context.restore();
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
            updateCropOverlay();
            setProgress(100);
            window.setTimeout(() => setProgress(0, false), 300);
            setStatus(`Aperçu prêt · source ${sourceBitmap.width} × ${sourceBitmap.height} px`);
        } catch (error) {
            setProgress(0, false);
            setStatus(error.message || 'Aperçu impossible.', true);
        }
    }

    function drawPreviewSource() {
        renderBitmap(originalCanvas, 1400, !cropEditing);
        processedCanvas.width = originalCanvas.width;
        processedCanvas.height = originalCanvas.height;
        processedCanvas.getContext('2d', {alpha: false}).drawImage(originalCanvas, 0, 0);
        updateCropOverlay();
    }

    function schedulePreview() {
        window.clearTimeout(previewTimer);
        previewTimer = window.setTimeout(updatePreview, 140);
    }

    function scheduleGeometryPreview() {
        window.clearTimeout(geometryTimer);
        geometryTimer = window.setTimeout(async () => {
            drawPreviewSource();
            await updatePreview();
        }, 90);
    }

    function isRawFile(file) {
        return rawExtensions.has((file.name.split('.').pop() || '').toLowerCase());
    }

    async function decodeRaw(file) {
        if (!window.crossOriginIsolated || typeof window.SharedArrayBuffer === 'undefined' || typeof window.WebAssembly === 'undefined') {
            throw new Error('Le traitement RAW n’est pas disponible dans ce navigateur. Actualisez la page, puis réessayez avec une version récente de Chrome, Edge, Firefox ou Safari. Les fichiers JPEG, PNG et WebP restent utilisables.');
        }
        setStatus('Chargement du décodeur RAW local…');
        setProgress(4);
        const {default: LibRaw} = await import('/vendor/libraw/index.js');
        const decoder = new LibRaw();
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            setStatus('Développement du fichier RAW…');
            setProgress(12);
            await decoder.open(bytes, {
                useCameraWb: true,
                useCameraMatrix: 1,
                outputColor: 1,
                outputBps: 8,
                highlight: 3,
                userQual: 3,
            });
            const decoded = await decoder.imageData();
            if (!decoded?.data || !decoded.width || !decoded.height) throw new Error('Ce fichier RAW n’a pas pu être développé.');
            if (decoded.width * decoded.height > 60000000) throw new Error('Ce RAW dépasse la limite de 60 mégapixels du laboratoire en ligne.');
            const channels = Math.max(3, Number(decoded.colors) || 3);
            const source = decoded.data;
            const rgba = new Uint8ClampedArray(decoded.width * decoded.height * 4);
            const sixteenBits = source instanceof Uint16Array || Number(decoded.bits) > 8;
            for (let pixel = 0; pixel < decoded.width * decoded.height; pixel++) {
                const sourceIndex = pixel * channels;
                const targetIndex = pixel * 4;
                rgba[targetIndex] = sixteenBits ? source[sourceIndex] / 257 : source[sourceIndex];
                rgba[targetIndex + 1] = sixteenBits ? source[sourceIndex + 1] / 257 : source[sourceIndex + 1];
                rgba[targetIndex + 2] = sixteenBits ? source[sourceIndex + 2] / 257 : source[sourceIndex + 2];
                rgba[targetIndex + 3] = 255;
            }
            const canvas = document.createElement('canvas');
            canvas.width = decoded.width;
            canvas.height = decoded.height;
            canvas.getContext('2d', {alpha: false}).putImageData(new ImageData(rgba, decoded.width, decoded.height), 0, 0);
            return await createImageBitmap(canvas);
        } finally {
            decoder.dispose();
        }
    }

    async function openFile(file) {
        if (!file) return;
        const raw = isRawFile(file);
        if (!raw && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            setStatus('Format non pris en charge. Utilisez JPEG, PNG, WebP ou un RAW compatible.', true);
            return;
        }
        const maximumBytes = raw ? 220 * 1024 * 1024 : 60 * 1024 * 1024;
        if (file.size > maximumBytes) {
            setStatus(`Le fichier dépasse la limite de ${raw ? 220 : 60} Mo.`, true);
            return;
        }
        setStatus(raw ? 'Ouverture du fichier RAW…' : 'Ouverture de la photographie…');
        try {
            sourceBitmap?.close?.();
            sourceBitmap = raw ? await decodeRaw(file) : await createImageBitmap(file, {imageOrientation: 'from-image'});
            if (sourceBitmap.width * sourceBitmap.height > 60000000) throw new Error('La photographie dépasse la limite de 60 mégapixels.');
            sourceFile = file;
            crop = {x: 0, y: 0, width: 1, height: 1};
            rotationDegrees = 0;
            rotation.value = '0';
            rotationValue.value = '0,0°';
            cropRatio.value = 'free';
            cropEditing = false;
            zoom.value = '100';
            updateZoom();
            drawPreviewSource();
            workspace.style.display = 'block';
            drop.style.display = 'none';
            await updatePreview();
        } catch (error) {
            sourceBitmap?.close?.();
            sourceBitmap = null;
            sourceFile = null;
            setProgress(0, false);
            setStatus(error.message || 'Impossible de lire cette photographie.', true);
        }
    }

    function outputExtension(mime) {
        return mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
    }

    async function canvasBlob(canvas, mime, encodingQuality) {
        return await new Promise(resolve => canvas.toBlob(resolve, mime, encodingQuality));
    }

    function resizedCanvas(source, scale) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        const context = canvas.getContext('2d', {alpha: false});
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    async function competitionBlob(sourceCanvas) {
        let canvas = sourceCanvas;
        const upperQuality = Math.min(0.96, Number(quality.value) / 100);
        for (let sizeAttempt = 0; sizeAttempt < 6; sizeAttempt++) {
            let low = 0.42, high = upperQuality, best = null;
            for (let attempt = 0; attempt < 8; attempt++) {
                const candidateQuality = (low + high) / 2;
                const candidate = await canvasBlob(canvas, 'image/jpeg', candidateQuality);
                if (!candidate) throw new Error('Votre navigateur ne peut pas créer le JPEG concours.');
                if (candidate.size <= MAX_CONTEST_BYTES) {
                    best = candidate;
                    low = candidateQuality;
                } else {
                    high = candidateQuality;
                }
            }
            if (best) return {blob: best, canvas};
            canvas = resizedCanvas(canvas, 0.9);
        }
        const fallback = await canvasBlob(canvas, 'image/jpeg', 0.4);
        if (!fallback || fallback.size > MAX_CONTEST_BYTES) throw new Error('Impossible de descendre sous 2,7 Mo avec cette image.');
        return {blob: fallback, canvas};
    }

    async function downloadResult(mode) {
        if (!sourceBitmap || !sourceFile) return;
        const competition = mode === 'competition';
        downloadCompetition.disabled = true;
        downloadFull.disabled = true;
        setStatus(competition ? 'Préparation de l’export concours…' : 'Préparation de l’export pleine taille…');
        setProgress(3);
        try {
            let canvas = document.createElement('canvas');
            const context = renderBitmap(canvas, competition ? 1920 : Infinity, true);
            const original = context.getImageData(0, 0, canvas.width, canvas.height);
            const result = await processImageData(original, value => setProgress(value));
            context.putImageData(result, 0, 0);
            setStatus('Encodage du fichier…');
            setProgress(97);

            let blob, mime;
            if (competition) {
                const encoded = await competitionBlob(canvas);
                blob = encoded.blob;
                canvas = encoded.canvas;
                mime = 'image/jpeg';
            } else {
                mime = format.value;
                blob = await canvasBlob(canvas, mime, Number(quality.value) / 100);
            }
            if (!blob) throw new Error('Votre navigateur ne peut pas créer ce format.');
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            const baseName = sourceFile.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'photo';
            anchor.href = url;
            anchor.download = `${baseName}-${suffixes[preset] || 'traitee'}-${competition ? 'concours' : 'pleine-taille'}-${canvas.width}x${canvas.height}.${outputExtension(mime)}`;
            anchor.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1500);
            setProgress(100);
            const megabytes = (blob.size / 1024 / 1024).toFixed(2).replace('.', ',');
            setStatus(`Téléchargement prêt · ${canvas.width} × ${canvas.height} px · ${megabytes} Mo`);
            window.setTimeout(() => setProgress(0, false), 500);
        } catch (error) {
            setProgress(0, false);
            setStatus(error.message || 'Export impossible.', true);
        } finally {
            downloadCompetition.disabled = false;
            downloadFull.disabled = false;
        }
    }

    function signedValue(value) {
        const number = Number(value);
        return number > 0 ? `+${number}` : String(number);
    }

    function updateZoom() {
        const scale = Number(zoom.value) / 100;
        previewStage.style.width = `${scale * 100}%`;
        previewStage.style.height = `${scale * 100}%`;
        zoomValue.value = scale === 1 ? 'Ajusté à l’écran' : `${zoom.value} %`;
        if (scale <= 1) {
            preview.scrollLeft = 0;
            preview.scrollTop = 0;
        }
        window.requestAnimationFrame(updateCropOverlay);
    }

    function updateCropOverlay() {
        if (!cropEditing || !sourceBitmap) {
            cropOverlay.classList.remove('active');
            return;
        }
        cropOverlay.classList.add('active');
        const canvasRect = originalCanvas.getBoundingClientRect();
        const stageRect = previewStage.getBoundingClientRect();
        cropOverlay.style.left = `${canvasRect.left - stageRect.left + crop.x * canvasRect.width}px`;
        cropOverlay.style.top = `${canvasRect.top - stageRect.top + crop.y * canvasRect.height}px`;
        cropOverlay.style.width = `${crop.width * canvasRect.width}px`;
        cropOverlay.style.height = `${crop.height * canvasRect.height}px`;
    }

    function showGrid() {
        cropOverlay.classList.add('show-grid');
        window.clearTimeout(gridTimer);
        gridTimer = window.setTimeout(() => cropOverlay.classList.remove('show-grid'), 750);
    }

    function normalizedPointer(event) {
        const rect = originalCanvas.getBoundingClientRect();
        return {
            x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
            y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
        };
    }

    function fixedRatio() {
        if (cropRatio.value === 'free') return null;
        const bounds = rotatedBounds(sourceBitmap.width, sourceBitmap.height);
        if (cropRatio.value === 'original') return sourceBitmap.width / sourceBitmap.height;
        return Number(cropRatio.value) || (bounds.width / bounds.height);
    }

    function centeredCropForRatio(ratio) {
        const bounds = rotatedBounds(sourceBitmap.width, sourceBitmap.height);
        const fullRatio = bounds.width / bounds.height;
        if (ratio >= fullRatio) {
            const height = fullRatio / ratio;
            crop = {x: 0, y: (1 - height) / 2, width: 1, height};
        } else {
            const width = ratio / fullRatio;
            crop = {x: (1 - width) / 2, y: 0, width, height: 1};
        }
    }

    function setCropEditing(enabled) {
        cropEditing = enabled;
        root.querySelectorAll('[data-lab-tab]').forEach(button => {
            const active = (button.dataset.labTab === 'crop') === enabled;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
        byId('photoLabRenderPanel').classList.toggle('active', !enabled);
        byId('photoLabCropPanel').classList.toggle('active', enabled);
        exitHorizonMode();
        if (sourceBitmap) scheduleGeometryPreview();
    }

    function exitHorizonMode() {
        horizonMode = false;
        horizonStart = null;
        preview.classList.remove('horizon-mode');
        horizonButton.classList.remove('btn-gold');
        horizonButton.classList.add('btn-outline');
        horizonLine.style.display = 'none';
        cropHelp.textContent = 'Déplacez le cadre ou ses poignées. La grille apparaît pendant le redressement. Pour l’horizon, tracez une ligne le long d’un repère qui devrait être horizontal.';
    }

    function clearFile() {
        sourceBitmap?.close?.();
        sourceBitmap = null;
        sourceFile = null;
        input.value = '';
        workspace.style.display = 'none';
        drop.style.display = 'block';
        cropOverlay.classList.remove('active');
        exitHorizonMode();
        setProgress(0, false);
        setStatus('Choisissez une photographie.');
    }

    input.addEventListener('change', event => openFile(event.target.files?.[0]));
    for (const eventName of ['dragenter', 'dragover']) drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.add('dragover'); });
    for (const eventName of ['dragleave', 'drop']) drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.remove('dragover'); });
    drop.addEventListener('drop', event => openFile(event.dataTransfer?.files?.[0]));

    compare.addEventListener('input', () => {
        processedCanvas.style.clipPath = `inset(0 0 0 ${compare.value}%)`;
        divider.style.left = `${compare.value}%`;
    });
    denoise.addEventListener('input', () => { denoiseValue.value = denoiseLabels[Number(denoise.value)]; schedulePreview(); });
    autoStrength.addEventListener('input', () => { autoStrengthValue.value = `${autoStrength.value} %`; schedulePreview(); });
    dehaze.addEventListener('input', () => { dehazeValue.value = signedValue(dehaze.value); schedulePreview(); });
    saturation.addEventListener('input', () => { saturationValue.value = signedValue(saturation.value); schedulePreview(); });
    highlights.addEventListener('input', () => { highlightsValue.value = signedValue(highlights.value); schedulePreview(); });
    shadows.addEventListener('input', () => { shadowsValue.value = signedValue(shadows.value); schedulePreview(); });
    zoom.addEventListener('input', updateZoom);
    preview.addEventListener('dblclick', () => { if (!horizonMode) { zoom.value = '100'; updateZoom(); } });
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

    root.querySelectorAll('[data-lab-tab]').forEach(button => button.addEventListener('click', () => setCropEditing(button.dataset.labTab === 'crop')));
    cropRatio.addEventListener('change', () => {
        const ratio = fixedRatio();
        if (ratio) centeredCropForRatio(ratio);
        updateCropOverlay();
        showGrid();
    });
    rotation.addEventListener('input', () => {
        rotationDegrees = Number(rotation.value);
        rotationValue.value = `${rotationDegrees.toFixed(1).replace('.', ',')}°`;
        const ratio = fixedRatio();
        if (ratio) centeredCropForRatio(ratio);
        showGrid();
        scheduleGeometryPreview();
    });
    cropReset.addEventListener('click', () => {
        crop = {x: 0, y: 0, width: 1, height: 1};
        rotationDegrees = 0;
        rotation.value = '0';
        rotationValue.value = '0,0°';
        cropRatio.value = 'free';
        showGrid();
        scheduleGeometryPreview();
    });

    cropOverlay.addEventListener('pointerdown', event => {
        if (horizonMode) return;
        event.preventDefault();
        cropOverlay.setPointerCapture?.(event.pointerId);
        cropDrag = {
            handle: event.target.dataset.handle || 'move',
            start: normalizedPointer(event),
            crop: {...crop},
        };
        showGrid();
    });
    cropOverlay.addEventListener('pointermove', event => {
        if (!cropDrag) return;
        const point = normalizedPointer(event);
        const dx = point.x - cropDrag.start.x;
        const dy = point.y - cropDrag.start.y;
        const start = cropDrag.crop;
        if (cropDrag.handle === 'move') {
            crop.x = clamp(start.x + dx, 0, 1 - start.width);
            crop.y = clamp(start.y + dy, 0, 1 - start.height);
        } else {
            let left = start.x, top = start.y, right = start.x + start.width, bottom = start.y + start.height;
            if (cropDrag.handle.includes('w')) left = clamp(point.x, 0, right - 0.05);
            if (cropDrag.handle.includes('e')) right = clamp(point.x, left + 0.05, 1);
            if (cropDrag.handle.includes('n')) top = clamp(point.y, 0, bottom - 0.05);
            if (cropDrag.handle.includes('s')) bottom = clamp(point.y, top + 0.05, 1);
            crop = {x: left, y: top, width: right - left, height: bottom - top};
            const ratio = fixedRatio();
            if (ratio) {
                const bounds = rotatedBounds(sourceBitmap.width, sourceBitmap.height);
                const desiredHeight = crop.width * bounds.width / (ratio * bounds.height);
                if (cropDrag.handle.includes('n')) crop.y = clamp(bottom - desiredHeight, 0, bottom - 0.05);
                crop.height = Math.min(desiredHeight, 1 - crop.y);
            }
        }
        showGrid();
        updateCropOverlay();
    });
    const finishCropDrag = () => { cropDrag = null; };
    cropOverlay.addEventListener('pointerup', finishCropDrag);
    cropOverlay.addEventListener('pointercancel', finishCropDrag);

    horizonButton.addEventListener('click', () => {
        horizonMode = !horizonMode;
        preview.classList.toggle('horizon-mode', horizonMode);
        horizonButton.classList.toggle('btn-gold', horizonMode);
        horizonButton.classList.toggle('btn-outline', !horizonMode);
        cropHelp.textContent = horizonMode
            ? 'Cliquez puis faites glisser le long d’une ligne qui devrait être horizontale.'
            : 'Déplacez le cadre ou ses poignées. La grille apparaît pendant le redressement.';
    });
    preview.addEventListener('pointerdown', event => {
        if (!horizonMode) return;
        event.preventDefault();
        horizonStart = {x: event.clientX, y: event.clientY};
        const stageRect = previewStage.getBoundingClientRect();
        horizonLine.style.left = `${event.clientX - stageRect.left}px`;
        horizonLine.style.top = `${event.clientY - stageRect.top}px`;
        horizonLine.style.width = '0px';
        horizonLine.style.display = 'block';
        preview.setPointerCapture?.(event.pointerId);
    });
    preview.addEventListener('pointermove', event => {
        if (!horizonMode || !horizonStart) return;
        const dx = event.clientX - horizonStart.x;
        const dy = event.clientY - horizonStart.y;
        horizonLine.style.width = `${Math.hypot(dx, dy)}px`;
        horizonLine.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
        cropOverlay.classList.add('show-grid');
    });
    preview.addEventListener('pointerup', event => {
        if (!horizonMode || !horizonStart) return;
        const dx = event.clientX - horizonStart.x;
        const dy = event.clientY - horizonStart.y;
        if (Math.hypot(dx, dy) >= 20) {
            const lineAngle = Math.atan2(dy, dx) * 180 / Math.PI;
            rotationDegrees = clamp(rotationDegrees - lineAngle, -15, 15);
            rotation.value = rotationDegrees.toFixed(1);
            rotationValue.value = `${rotationDegrees.toFixed(1).replace('.', ',')}°`;
            showGrid();
            scheduleGeometryPreview();
        }
        exitHorizonMode();
    });

    window.addEventListener('resize', () => window.requestAnimationFrame(updateCropOverlay));
    downloadCompetition.addEventListener('click', () => downloadResult('competition'));
    downloadFull.addEventListener('click', () => downloadResult('full'));
    clear.addEventListener('click', clearFile);
})();
