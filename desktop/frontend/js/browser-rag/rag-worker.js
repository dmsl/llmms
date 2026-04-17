let retriever = null;
let initialized = false;
let initializingPromise = null;
const cancelledJobs = new Set();

async function ensureInitialized() {
    if (initialized && retriever) {
        return;
    }
    if (initializingPromise) {
        return initializingPromise;
    }

    initializingPromise = (async () => {
        importScripts(
            'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs',
            'https://cdn.jsdelivr.net/npm/@tensorflow-models/universal-sentence-encoder',
            './rag-policy.js',
            './indexed-db-vector-store.js',
            './browser-retriever.js'
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
