let retriever = null;
let initialized = false;
let initializingPromise = null;
const cancelledJobs = new Set();
const RAG_ASSET_URLS = {
    tfjsUrl: new URL('../../vendor/tfjs/tf.min.js', self.location.href).href,
    useScriptUrl: new URL('../../vendor/use/universal-sentence-encoder.min.js', self.location.href).href,
    useModelUrl: new URL('../../vendor/use/model/model.json', self.location.href).href,
    useVocabUrl: new URL('../../vendor/use/model/vocab.json', self.location.href).href,
    jszipUrl: new URL('../../vendor/jszip/jszip.min.js', self.location.href).href,
    xlsxUrl: new URL('../../vendor/xlsx/xlsx.full.min.js', self.location.href).href,
    documentParserUrl: new URL('../document-parser.js', self.location.href).href,
    ragPolicyUrl: new URL('./rag-policy.js', self.location.href).href,
    vectorStoreUrl: new URL('./indexed-db-vector-store.js', self.location.href).href,
    retrieverUrl: new URL('./browser-retriever.js', self.location.href).href
};

self.RAG_ASSET_URLS = RAG_ASSET_URLS;

async function ensureInitialized() {
    if (initialized && retriever) {
        return;
    }
    if (initializingPromise) {
        return initializingPromise;
    }

    initializingPromise = (async () => {
        importScripts(
            RAG_ASSET_URLS.tfjsUrl,
            RAG_ASSET_URLS.useScriptUrl,
            RAG_ASSET_URLS.jszipUrl,
            RAG_ASSET_URLS.xlsxUrl,
            RAG_ASSET_URLS.documentParserUrl,
            RAG_ASSET_URLS.ragPolicyUrl,
            RAG_ASSET_URLS.vectorStoreUrl,
            RAG_ASSET_URLS.retrieverUrl
        );

        if (typeof BrowserRetriever === 'undefined') {
            throw new Error('BrowserRetriever is not available inside worker');
        }

        retriever = new BrowserRetriever();
        initialized = true;
    })();

    return initializingPromise;
}

function isCancelled(jobId) {
    return cancelledJobs.has(jobId);
}

self.onmessage = async (event) => {
    const message = event.data || {};
    const { type, jobId, payload = {} } = message;

    if (type === 'cancel' && jobId) {
        cancelledJobs.add(jobId);
        return;
    }

    try {
        await ensureInitialized();

        if (type === 'indexText') {
            if (!payload.text || !payload.descriptor) {
                throw new Error('Missing payload for indexText');
            }

            const result = await retriever.ingestText(payload.text, payload.descriptor, {
                shouldAbort: () => isCancelled(jobId),
                onProgress: (progress) => {
                    self.postMessage({
                        type: 'progress',
                        jobId,
                        progress
                    });
                },
                limits: payload.limits || null
            });

            cancelledJobs.delete(jobId);
            self.postMessage({
                type: 'result',
                jobId,
                result
            });
            return;
        }

        if (type === 'retrieve') {
            const { query, maxResults, filters, options } = payload;
            if (!query) {
                throw new Error('Missing query for retrieve');
            }

            if (isCancelled(jobId)) {
                cancelledJobs.delete(jobId);
                self.postMessage({
                    type: 'error',
                    jobId,
                    error: 'cancelled'
                });
                return;
            }

            const docs = await retriever.retrieveRelevantDocuments(
                query,
                maxResults,
                filters || {},
                options || {}
            );

            if (isCancelled(jobId)) {
                cancelledJobs.delete(jobId);
                self.postMessage({
                    type: 'error',
                    jobId,
                    error: 'cancelled'
                });
                return;
            }

            cancelledJobs.delete(jobId);
            self.postMessage({
                type: 'result',
                jobId,
                result: docs
            });
            return;
        }

        if (type === 'init') {
            self.postMessage({
                type: 'result',
                jobId,
                result: { ok: true }
            });
            return;
        }

        throw new Error(`Unsupported worker message type: ${type}`);
    } catch (error) {
        cancelledJobs.delete(jobId);
        self.postMessage({
            type: 'error',
            jobId,
            error: error?.message || String(error)
        });
    }
};
