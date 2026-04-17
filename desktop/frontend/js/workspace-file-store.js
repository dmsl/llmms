const DB_NAME = 'chatucy_workspace_files';
const STORE_NAME = 'files';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
    });

    return dbPromise;
}

function runTransaction(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);

        let request;
        try {
            request = fn(store);
        } catch (error) {
            reject(error);
            return;
        }

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB operation failed'));
    }));
}

export function createWorkspaceFileStorageKey(workspaceId, fileId) {
    return `${workspaceId}:${fileId}`;
}

export async function putWorkspaceFileBlob(storageKey, blob) {
    if (!storageKey) throw new Error('storageKey is required');
    if (!(blob instanceof Blob)) throw new Error('blob must be a Blob');
    await runTransaction('readwrite', store => store.put(blob, storageKey));
}

export async function getWorkspaceFileBlob(storageKey) {
    if (!storageKey) return null;
    const value = await runTransaction('readonly', store => store.get(storageKey));
    return value || null;
}

export async function deleteWorkspaceFileBlob(storageKey) {
    if (!storageKey) return;
    await runTransaction('readwrite', store => store.delete(storageKey));
}

export async function clearWorkspaceFileBlobs(storageKeys) {
    if (!Array.isArray(storageKeys) || storageKeys.length === 0) return;
    const db = await openDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const key of storageKeys) {
            if (key) store.delete(key);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Failed to clear workspace blobs'));
    });
}

export async function dataUrlToBlob(dataUrl) {
    if (!dataUrl) throw new Error('dataUrl is required');
    const response = await fetch(dataUrl);
    return response.blob();
}

export async function blobToDataUrl(blob) {
    if (!(blob instanceof Blob)) throw new Error('blob must be a Blob');
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
        reader.readAsDataURL(blob);
    });
}
