'use strict';

(() => {
    const root = document.getElementById('watermarkTool');
    if (!root) return;
    const byId = id => document.getElementById(id);
    const input = byId('watermarkPhotos');
    const logoInput = byId('watermarkLogo');
    const fontInput = byId('watermarkFontFile');
    const preview = byId('watermarkPreview');
    const list = byId('watermarkFiles');
    const status = byId('watermarkStatus');
    const exportButton = byId('watermarkExport');
    const advancedToggle = byId('watermarkAdvancedToggle');
    const advancedPanel = byId('watermarkAdvancedPanel');
    const advancedExport = byId('watermarkAdvancedExport');
    const advancedFormat = byId('watermarkAdvancedFormat');
    const quality = byId('watermarkQuality');
    const qualityRow = byId('watermarkQualityRow');
    const formatNote = byId('watermarkFormatNote');
    const fontSamples = byId('watermarkFontSamples');
    const modeButtons = root.querySelectorAll('input[name="watermarkMode"]');
    const text = byId('watermarkText');
    const font = byId('watermarkFont');
    const bold = byId('watermarkBold');
    const italic = byId('watermarkItalic');
    const underline = byId('watermarkUnderline');
    const color = byId('watermarkColor');
    const opacity = byId('watermarkOpacity');
    const size = byId('watermarkSize');
    const sizeValue = byId('watermarkSizeValue');
    const sizePixels = byId('watermarkSizePixels');
    const inset = byId('watermarkInset');
    const textFields = byId('watermarkTextFields');
    const logoFields = byId('watermarkLogoFields');
    const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
    const encoder = new TextEncoder();
    const crcTable = new Uint32Array(256);
    for (let value = 0; value < 256; value++) {
        let crc = value;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        crcTable[value] = crc >>> 0;
    }
    const positions = {
        'top-left': [0, 0], 'top-center': [.5, 0], 'top-right': [1, 0],
        'middle-left': [0, .5], 'middle-center': [.5, .5], 'middle-right': [1, .5],
        'bottom-left': [0, 1], 'bottom-center': [.5, 1], 'bottom-right': [1, 1],
    };
    let files = [];
    let logoBitmap = null;
    let customFontUrl = null;
    let previewBitmap = null;
    let previewFile = null;
    let previewNotice = '';
    let previewGeneration = 0;
    let previewTimer = null;
    let exporting = false;
    const sizeByMode = {text: '5', logo: '18'};

    function report(message, error = false) {
        status.textContent = message;
        status.style.color = error ? '#ff8f8f' : '';
    }

    function currentMode() {
        return root.querySelector('input[name="watermarkMode"]:checked')?.value || 'text';
    }

    function updateFontSamples() {
        const sample = text.value.trim() || 'Votre signature';
        fontSamples.replaceChildren();
        for (const option of font.options) {
            if (option.value === 'custom' && !customFontUrl) continue;
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.font = option.value;
            button.setAttribute('aria-pressed', String(font.value === option.value));
            const title = document.createElement('small');
            title.textContent = option.textContent;
            const example = document.createElement('span');
            example.textContent = sample;
            example.style.fontFamily = option.value === 'custom' ? 'PhotoClubCustomWatermark' : option.value;
            button.append(title, example);
            button.addEventListener('click', () => {
                font.value = option.value;
                fontSamples.querySelectorAll('button').forEach(candidate =>
                    candidate.setAttribute('aria-pressed', String(candidate.dataset.font === option.value))
                );
                schedulePreview();
            });
            fontSamples.append(button);
        }
    }

    function settings() {
        return {
            mode: currentMode(),
            text: text.value,
            font: font.value,
            bold: bold.checked,
            italic: italic.checked,
            underline: underline.checked,
            color: color.value,
            opacity: Number(opacity.value) / 100,
            size: Number(size.value) / 100,
            inset: Number(inset.value) / 100,
            position: root.querySelector('input[name="watermarkPosition"]:checked')?.value || 'bottom-right',
        };
    }

    function updateSizeOutput() {
        sizeValue.value = `${size.value} %`;
        sizePixels.textContent = previewBitmap
            ? `Sur cette photo : environ ${Math.max(1, Math.round(Math.min(previewBitmap.width, previewBitmap.height) * Number(size.value) / 100))} px ${currentMode() === 'logo' ? 'de largeur' : 'de hauteur de police'}. La proportion reste la même pour chaque photo du lot.`
            : 'La taille est calculée sur le bord court de chaque photo : même proportion quelle que soit sa résolution.';
    }

    function drawWatermark(context, width, height, options) {
        const shortEdge = Math.min(width, height);
        const margin = Math.round(shortEdge * options.inset);
        const [horizontal, vertical] = positions[options.position];
        if (options.opacity <= 0) return;
        context.save();
        context.globalAlpha = options.opacity;
        let markWidth, markHeight, baseline = 0;
        if (options.mode === 'logo') {
            if (!logoBitmap) throw new Error('Choisissez un logo PNG avant l’export.');
            markWidth = Math.min(width - 2 * margin, Math.max(1, shortEdge * options.size));
            markHeight = markWidth * logoBitmap.height / logoBitmap.width;
            if (markHeight > height - 2 * margin) {
                markHeight = height - 2 * margin;
                markWidth = markHeight * logoBitmap.width / logoBitmap.height;
            }
        } else {
            if (!options.text.trim()) throw new Error('Écrivez la signature avant l’export.');
            if (options.font === 'custom' && !customFontUrl) throw new Error('Importez d’abord votre police locale.');
            const family = options.font === 'custom' ? 'PhotoClubCustomWatermark' : options.font;
            let fontPixels = Math.max(1, Math.round(shortEdge * options.size));
            context.font = `${options.italic ? 'italic ' : ''}${options.bold ? 'bold ' : ''}${fontPixels}px ${family}`;
            const availableWidth = Math.max(1, width - 2 * margin);
            const measured = context.measureText(options.text);
            if (measured.width > availableWidth) {
                fontPixels = Math.max(1, Math.floor(fontPixels * availableWidth / measured.width));
                context.font = `${options.italic ? 'italic ' : ''}${options.bold ? 'bold ' : ''}${fontPixels}px ${family}`;
            }
            const metrics = context.measureText(options.text);
            markWidth = metrics.width;
            baseline = metrics.actualBoundingBoxAscent || fontPixels * .8;
            markHeight = baseline + (metrics.actualBoundingBoxDescent || fontPixels * .25) + (options.underline ? fontPixels * .1 : 0);
        }
        const x = horizontal === 0 ? margin : horizontal === 1 ? width - margin - markWidth : (width - markWidth) / 2;
        const y = vertical === 0 ? margin : vertical === 1 ? height - margin - markHeight : (height - markHeight) / 2;
        if (options.mode === 'logo') {
            context.drawImage(logoBitmap, x, y, markWidth, markHeight);
        } else {
            context.fillStyle = options.color;
            context.textBaseline = 'alphabetic';
            context.fillText(options.text, x, y + baseline);
            if (options.underline) {
                const lineY = y + baseline + Math.max(2, shortEdge * options.size * .045);
                context.lineWidth = Math.max(1, shortEdge * options.size * .045);
                context.beginPath();
                context.moveTo(x, lineY);
                context.lineTo(x + markWidth, lineY);
                context.strokeStyle = options.color;
                context.stroke();
            }
        }
        context.restore();
    }

    async function decodeFile(file) {
        if (file.size > 220 * 1024 * 1024) throw new Error(`${file.name} dépasse 220 Mo : traitez ce fichier séparément.`);
        if (window.PhotoClubRaw?.isRawFile(file)) {
            return await window.PhotoClubRaw.decode(file, {
                setStatus: message => report(message),
                setProgress: () => {},
            });
        }
        try {
            const bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'});
            if (bitmap.width * bitmap.height > 60000000) {
                bitmap.close?.();
                throw new Error(`${file.name} dépasse 60 mégapixels : export impossible sur cet appareil.`);
            }
            return {bitmap, notice: ''};
        } catch (error) {
            if (error.message?.includes('mégapixels')) throw error;
            throw new Error(`Format non décodable dans ce navigateur : ${file.name}.`);
        }
    }

    async function renderPreview() {
        const generation = ++previewGeneration;
        const file = files[0];
        if (!file) {
            previewBitmap?.close?.();
            previewBitmap = null;
            previewFile = null;
            preview.width = 0;
            preview.height = 0;
            updateSizeOutput();
            return;
        }
        try {
            if (previewFile !== file || !previewBitmap) {
                previewBitmap?.close?.();
                previewBitmap = null;
                const decoded = await decodeFile(file);
                if (generation !== previewGeneration) {
                    decoded.bitmap.close?.();
                    return;
                }
                previewBitmap = decoded.bitmap;
                previewFile = file;
                previewNotice = decoded.notice;
                updateSizeOutput();
            }
            if (generation !== previewGeneration) return;
            const scale = Math.min(1, 1200 / Math.max(previewBitmap.width, previewBitmap.height));
            const width = Math.max(1, Math.round(previewBitmap.width * scale));
            const height = Math.max(1, Math.round(previewBitmap.height * scale));
            if (preview.width !== width || preview.height !== height) {
                preview.width = width;
                preview.height = height;
            }
            const context = preview.getContext('2d', {alpha: true});
            context.clearRect(0, 0, preview.width, preview.height);
            context.drawImage(previewBitmap, 0, 0, preview.width, preview.height);
            if (currentMode() === 'text' ? text.value.trim() : logoBitmap) {
                drawWatermark(context, preview.width, preview.height, settings());
            }
            report(previewNotice ? `Aperçu : ${file.name} · ${previewNotice}` : `Aperçu : ${file.name}`);
        } catch (error) {
            if (generation === previewGeneration) report(error.message, true);
        }
    }

    function schedulePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(renderPreview, 120);
    }

    function updateFileList() {
        list.replaceChildren();
        files.forEach((file, index) => {
            const item = document.createElement('li');
            const show = document.createElement('button');
            show.type = 'button';
            show.textContent = file.name;
            show.title = 'Voir cette photo en aperçu';
            show.addEventListener('click', () => {
                files.splice(index, 1);
                files.unshift(file);
                updateFileList();
                schedulePreview();
            });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.setAttribute('aria-label', `Retirer ${file.name}`);
            remove.addEventListener('click', () => {
                files.splice(index, 1);
                updateFileList();
                schedulePreview();
            });
            item.append(show, remove);
            list.append(item);
        });
        exportButton.disabled = exporting || files.length === 0;
        advancedExport.disabled = exporting || files.length === 0;
        report(files.length ? `${files.length} photo${files.length > 1 ? 's' : ''} sélectionnée${files.length > 1 ? 's' : ''}.` : 'Choisissez une ou plusieurs photos.');
    }

    function crc32(bytes) {
        let crc = 0xffffffff;
        for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
        return (crc ^ 0xffffffff) >>> 0;
    }

    function zipStore(entries) {
        const parts = [], directory = [];
        let offset = 0;
        for (const entry of entries) {
            const name = encoder.encode(entry.name);
            const bytes = entry.bytes;
            const crc = crc32(bytes);
            const local = new Uint8Array(30);
            const localView = new DataView(local.buffer);
            localView.setUint32(0, 0x04034b50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, 0x0800, true); // UTF-8 names
            localView.setUint32(14, crc, true);
            localView.setUint32(18, bytes.length, true);
            localView.setUint32(22, bytes.length, true);
            localView.setUint16(26, name.length, true);
            parts.push(local, name, bytes);
            const central = new Uint8Array(46);
            const centralView = new DataView(central.buffer);
            centralView.setUint32(0, 0x02014b50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, 0x0800, true);
            centralView.setUint32(16, crc, true);
            centralView.setUint32(20, bytes.length, true);
            centralView.setUint32(24, bytes.length, true);
            centralView.setUint16(28, name.length, true);
            centralView.setUint32(42, offset, true);
            directory.push(central, name);
            offset += local.length + name.length + bytes.length;
        }
        const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
        const end = new Uint8Array(22);
        const endView = new DataView(end.buffer);
        endView.setUint32(0, 0x06054b50, true);
        endView.setUint16(8, entries.length, true);
        endView.setUint16(10, entries.length, true);
        endView.setUint32(12, directorySize, true);
        endView.setUint32(16, offset, true);
        return new Blob([...parts, ...directory, end], {type: 'application/zip'});
    }

    function download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    const formats = {
        png: {mime: 'image/png', extension: 'png', label: 'PNG'},
        jpeg: {mime: 'image/jpeg', extension: 'jpg', label: 'JPEG'},
        webp: {mime: 'image/webp', extension: 'webp', label: 'WebP'},
        tiff: {mime: 'image/tiff', extension: 'tif', label: 'TIFF'},
        jxl: {mime: 'image/jxl', extension: 'jxl', label: 'JPEG XL'},
    };

    function tiffBlob(canvas) {
        const width = canvas.width, height = canvas.height;
        const pixels = canvas.getContext('2d', {willReadFrequently: true})?.getImageData(0, 0, width, height).data;
        if (!pixels) throw new Error('Lecture des pixels TIFF impossible sur cet appareil.');
        const pixelOffset = 174;
        if (pixels.length + pixelOffset > 0xffffffff) throw new Error('TIFF trop grand pour ce format.');
        const bytes = new Uint8Array(pixelOffset + pixels.length);
        const view = new DataView(bytes.buffer);
        bytes[0] = 0x49; bytes[1] = 0x49; // little-endian TIFF
        view.setUint16(2, 42, true);
        view.setUint32(4, 8, true);
        view.setUint16(8, 12, true);
        const tags = [
            [256, 4, 1, width], [257, 4, 1, height], [258, 3, 4, 158],
            [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, pixelOffset],
            [277, 3, 1, 4], [278, 4, 1, height], [279, 4, 1, pixels.length],
            [284, 3, 1, 1], [338, 3, 1, 2], [339, 3, 4, 166],
        ];
        tags.forEach(([tag, type, count, value], index) => {
            const offset = 10 + index * 12;
            view.setUint16(offset, tag, true);
            view.setUint16(offset + 2, type, true);
            view.setUint32(offset + 4, count, true);
            if (type === 3 && count === 1) view.setUint16(offset + 8, value, true);
            else view.setUint32(offset + 8, value, true);
        });
        view.setUint32(154, 0, true);
        for (let index = 0; index < 4; index++) {
            view.setUint16(158 + index * 2, 8, true);
            view.setUint16(166 + index * 2, 1, true);
        }
        bytes.set(pixels, pixelOffset);
        return new Blob([bytes], {type: 'image/tiff'});
    }

    async function encodeCanvas(canvas, format, qualityValue) {
        if (format === 'tiff') return tiffBlob(canvas);
        const descriptor = formats[format];
        if (!descriptor) throw new Error('Format d’export inconnu.');
        const blob = await new Promise((resolve, reject) => canvas.toBlob(
            output => output ? resolve(output) : reject(new Error(`Encodage ${descriptor.label} impossible.`)),
            descriptor.mime, qualityValue / 100
        ));
        if (blob.type !== descriptor.mime) throw new Error(`${descriptor.label} n’est pas encodable dans ce navigateur ; aucun autre format n’a été exporté à sa place.`);
        return blob;
    }

    async function renderFullResolution(file, options, format, qualityValue) {
        const {bitmap, notice} = await decodeFile(file);
        try {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d', {alpha: format !== 'jpeg'});
            if (!context) throw new Error('Canevas trop grand pour cet appareil.');
            context.imageSmoothingEnabled = false;
            if (format === 'jpeg') {
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);
            }
            context.drawImage(bitmap, 0, 0); // 1:1: no resize, no colour adjustment.
            drawWatermark(context, canvas.width, canvas.height, options);
            return {blob: await encodeCanvas(canvas, format, qualityValue), notice};
        } finally {
            bitmap.close?.();
        }
    }

    async function exportSeries(format = 'jpeg', qualityValue = 95) {
        if (!files.length || exporting) return;
        if (!formats[format]) return report('Format d’export inconnu.', true);
        const descriptor = formats[format];
        const options = settings();
        if (options.mode === 'logo' && !logoBitmap) return report('Choisissez un logo PNG.', true);
        if (options.mode === 'text' && !options.text.trim()) return report('Écrivez la signature.', true);
        exporting = true;
        exportButton.disabled = true;
        advancedExport.disabled = true;
        const entries = [], failures = [], names = new Set();
        let totalSize = 0;
        try {
            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                report(`Export local ${index + 1}/${files.length} : ${file.name}…`);
                await new Promise(resolve => setTimeout(resolve, 0));
                try {
                    const result = await renderFullResolution(file, options, format, qualityValue);
                    const basename = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || 'photo';
                    let filename = `${basename}-filigrane.${descriptor.extension}`, suffix = 2;
                    while (names.has(filename)) filename = `${basename}-filigrane-${suffix++}.${descriptor.extension}`;
                    names.add(filename);
                    if (files.length === 1) {
                        download(result.blob, filename);
                        report(result.notice ? `Export ${descriptor.label} terminé · ${result.notice}` : `Export ${descriptor.label} terminé.`);
                        return;
                    }
                    totalSize += result.blob.size;
                    if (totalSize > 1024 * 1024 * 1024) throw new Error('La série dépasse 1 Go : exportez-la en plusieurs lots.');
                    entries.push({name: filename, bytes: new Uint8Array(await result.blob.arrayBuffer())});
                } catch (error) {
                    failures.push(`${file.name} : ${error.message}`);
                }
            }
            if (!entries.length) throw new Error(failures.join(' · ') || 'Aucune photo exportable.');
            const zip = zipStore(entries);
            download(zip, 'photos-filigrane.zip');
            report(`${entries.length} photo${entries.length > 1 ? 's' : ''} exportée${entries.length > 1 ? 's' : ''} en ${descriptor.label} dans un ZIP sans recompression.${failures.length ? ` ${failures.length} échec(s) : ${failures.join(' · ')}` : ''}`, failures.length > 0);
        } catch (error) {
            report(error.message || 'Export impossible.', true);
        } finally {
            exporting = false;
            exportButton.disabled = files.length === 0;
            advancedExport.disabled = files.length === 0;
        }
    }

    input.addEventListener('change', () => {
        files = [...input.files];
        updateFileList();
        schedulePreview();
    });
    logoInput.addEventListener('change', async () => {
        logoBitmap?.close?.();
        logoBitmap = null;
        const file = logoInput.files?.[0];
        if (!file) return schedulePreview();
        if (file.type !== 'image/png') return report('Le logo doit être un PNG, idéalement à fond transparent.', true);
        try {
            logoBitmap = await createImageBitmap(file);
            schedulePreview();
        } catch (_) {
            report('Logo PNG illisible.', true);
        }
    });
    fontInput.addEventListener('change', async () => {
        const file = fontInput.files?.[0];
        if (!file) return;
        if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) return report('Police attendue : TTF, OTF, WOFF ou WOFF2.', true);
        const url = URL.createObjectURL(file);
        try {
            const face = new FontFace('PhotoClubCustomWatermark', `url(${url})`);
            await face.load();
            document.fonts.add(face);
            if (customFontUrl) URL.revokeObjectURL(customFontUrl);
            customFontUrl = url;
            font.value = 'custom';
            updateFontSamples();
            report(`Police locale chargée : ${file.name}`);
            schedulePreview();
        } catch (_) {
            URL.revokeObjectURL(url);
            report('Cette police ne peut pas être chargée dans le navigateur.', true);
        }
    });
    modeButtons.forEach(button => button.addEventListener('change', () => {
        textFields.hidden = currentMode() !== 'text';
        logoFields.hidden = currentMode() !== 'logo';
        size.value = sizeByMode[currentMode()];
        updateSizeOutput();
        schedulePreview();
    }));
    root.querySelectorAll('input:not([type="file"]), select').forEach(control => {
        if (control.name === 'watermarkMode') return;
        control.addEventListener('input', schedulePreview);
        control.addEventListener('change', schedulePreview);
    });
    text.addEventListener('input', updateFontSamples);
    font.addEventListener('change', updateFontSamples);
    opacity.addEventListener('input', () => byId('watermarkOpacityValue').value = `${opacity.value} %`);
    size.addEventListener('input', () => {
        sizeByMode[currentMode()] = size.value;
        updateSizeOutput();
    });
    inset.addEventListener('input', () => byId('watermarkInsetValue').value = `${inset.value} %`);
    advancedToggle.addEventListener('click', () => {
        advancedPanel.hidden = !advancedPanel.hidden;
        advancedToggle.setAttribute('aria-expanded', String(!advancedPanel.hidden));
    });
    function updateFormatNote() {
        const selected = advancedFormat.value;
        qualityRow.hidden = !['jpeg', 'webp', 'jxl'].includes(selected);
        formatNote.textContent = {
            png: 'PNG conserve les pixels issus du décodage, sans compression avec perte.',
            tiff: 'TIFF RGBA non compressé : sans perte, mais très volumineux. Les profils couleur et métadonnées ne sont pas recopiés.',
            jpeg: 'JPEG est très compatible, mais compresse avec perte. Les zones transparentes deviennent blanches.',
            webp: 'WebP crée un fichier compact avec compression avec perte.',
            jxl: 'JPEG XL est proposé uniquement si ce navigateur sait réellement l’encoder.',
        }[selected];
    }
    advancedFormat.addEventListener('change', updateFormatNote);
    quality.addEventListener('input', () => byId('watermarkQualityValue').value = `${quality.value} %`);
    exportButton.addEventListener('click', () => exportSeries('jpeg', 95));
    advancedExport.addEventListener('click', () => exportSeries(advancedFormat.value, Number(quality.value)));
    const jxlOption = advancedFormat.querySelector('option[value="jxl"]');
    const probe = document.createElement('canvas');
    probe.width = probe.height = 2;
    probe.toBlob(blob => {
        const supported = blob?.type === 'image/jxl';
        jxlOption.disabled = !supported;
        jxlOption.textContent = supported ? 'JPEG XL · disponible' : 'JPEG XL · non encodable dans ce navigateur';
    }, 'image/jxl');
    updateFileList();
    updateSizeOutput();
    updateFontSamples();
    updateFormatNote();
})();
