let ocrScriptPromise = null;
let ocrWorkerPromise = null;
let ocrWorkerLang = null;

function resolveAssetUrl(relativePath) {
    return new URL(relativePath, import.meta.url).href;
}

const OCR_ASSETS = {
    scriptUrl: resolveAssetUrl('../../vendor/tesseract/tesseract.min.js'),
    workerPath: resolveAssetUrl('../../vendor/tesseract/worker.min.js'),
    corePath: resolveAssetUrl('../../vendor/tesseract/tesseract-core-lstm.wasm.js'),
    langPath: resolveAssetUrl('../../vendor/tesseract/lang')
};

function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) {
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load OCR script: ${src}`));
        document.head.appendChild(script);
    });
}

async function ensureOcrEngine() {
    if (window.Tesseract) {
        return window.Tesseract;
    }

    if (!ocrScriptPromise) {
        ocrScriptPromise = loadScriptOnce(OCR_ASSETS.scriptUrl);
    }

    await ocrScriptPromise;

    if (!window.Tesseract) {
        throw new Error('OCR engine is unavailable in this browser session.');
    }

    return window.Tesseract;
}

async function ensureOcrWorker(lang) {
    const Tesseract = await ensureOcrEngine();
    if (!ocrWorkerPromise) {
        ocrWorkerPromise = Tesseract.createWorker({
            logger: () => {},
            workerPath: OCR_ASSETS.workerPath,
            corePath: OCR_ASSETS.corePath,
            langPath: OCR_ASSETS.langPath
        });
    }

    const worker = await ocrWorkerPromise;
    const resolvedLang = lang || 'eng';
    if (resolvedLang !== ocrWorkerLang) {
        await worker.loadLanguage(resolvedLang);
        await worker.initialize(resolvedLang);
        ocrWorkerLang = resolvedLang;
    }

    return worker;
}

export async function extractImageTextWithOcr(file, { lang = 'eng' } = {}) {
    if (!file) {
        throw new Error('No image file was provided for OCR.');
    }

    const worker = await ensureOcrWorker(lang);
    const result = await worker.recognize(file);

    return {
        text: result?.data?.text || '',
        confidence: result?.data?.confidence ?? null
    };
}

export default extractImageTextWithOcr;
