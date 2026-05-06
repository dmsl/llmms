/**
 * Browser RAG Script - Multi-file Support with UI Throttling Prevention
 * 
 * Optimizations:
 * - Uses requestIdleCallback to process files during browser idle time
 * - Sequential processing with yields to prevent UI blocking
 * - Per-file AbortControllers for granular cancellation
 * - Model loading happens lazily (only when BrowserRetriever is first used)
 * - Efficient chunking to avoid memory spikes
 */

// Initialize Browser RAG
let browserRetriever = null;

let ragProcessingControllers = new Map(); // Map of file names to their AbortControllers
let isModelLoading = false; // Flag to prevent concurrent model loads


// Initialize the browser retriever when the page loads
document.addEventListener('DOMContentLoaded', () => {
    try {
        browserRetriever = new BrowserRetriever();
        console.log("Browser RAG initialized successfully");

        // Set initial state based on the checkbox
        const ragToggle = document.getElementById('rag-toggle');
        if (ragToggle) {
            // Initialize from localStorage or default to false
            const savedRagState = localStorage.getItem('localRagEnabled') === 'true';
            ragToggle.checked = savedRagState;
            isClientSideRagEnabled = savedRagState;

            // Add event listener to the RAG toggle
            ragToggle.addEventListener('change', function () {
                isClientSideRagEnabled = this.checked;
                // Save preference to localStorage
                localStorage.setItem('localRagEnabled', isClientSideRagEnabled);

                // If RAG is disabled, clear any existing documents
                if (!isClientSideRagEnabled && browserRetriever) {
                    browserRetriever.clearAllDocuments();
                }

                // Update UI with status message
                const fileNameEl = document.getElementById('file-name');
                if (fileNameEl && selectedFiles.length > 0) {
                    updateFileUI(isClientSideRagEnabled);
                }

                console.log(`Privacy ${isClientSideRagEnabled ? 'enabled' : 'disabled'}`);
            });
        }
    } catch (error) {
        console.error("Failed to initialize Browser RAG:", error);
        isClientSideRagEnabled = false;
        // Disable and hide the toggle if Browser RAG failed to initialize
        const ragToggle = document.getElementById('rag-toggle');
        if (ragToggle) {
            ragToggle.checked = false;
            ragToggle.disabled = true;
            ragToggle.parentElement.style.opacity = 0.5;
            ragToggle.parentElement.title = "Browser RAG unavailable";
        }
    }
});

// Function to update file UI based on RAG state
function updateFileUI(isEnabled) {
    const fileNameEl = document.getElementById('file-name');
    if (fileNameEl && fileNameEl.querySelector('.badge')) {
        if (isEnabled) {
            fileNameEl.querySelector('.badge').classList.add('bg-success', 'text-white');
            fileNameEl.querySelector('.badge').classList.remove('bg-light', 'text-dark');
        } else {
            fileNameEl.querySelector('.badge').classList.remove('bg-success', 'text-white');
            fileNameEl.querySelector('.badge').classList.add('bg-light', 'text-dark');
        }
    }
}

// Listen for file selection - UPDATED FOR MULTIPLE FILES
document.getElementById('file-input').addEventListener('change', async (event) => {
    selectedFiles = Array.from(event.target.files);
    const fileNameEl = document.getElementById('file-name');
    const fileInfoContainer = document.getElementById('file-info-container');

    if (selectedFiles.length > 0) {
        // Show file count or single file name
        const displayText = selectedFiles.length === 1 
            ? (selectedFiles[0].name.length > 15 ? selectedFiles[0].name.substring(0, 12) + '...' : selectedFiles[0].name)
            : `${selectedFiles.length} files selected`;

        // Show file info - with a "Ready for processing" indicator
        fileNameEl.innerHTML = `
            <div class="badge ${isClientSideRagEnabled ? 'bg-success text-white' : 'bg-light text-dark'} d-flex align-items-center p-2 mb-2">
                <i class="fa-solid fa-file me-2"></i>
                <span>${displayText}</span>
                ${isClientSideRagEnabled ? '<span class="ms-2 small"><i class="fa-solid fa-circle-info me-1"></i>Ready</span>' : ''}
                <button type="button" class="btn-close ms-2" aria-label="Remove files" id="remove-file-btn"></button>
            </div>
        `;
        fileInfoContainer.classList.remove('d-none');

        // Add event listener to the remove button
        setTimeout(() => {
            const removeBtn = document.getElementById('remove-file-btn');
            if (removeBtn) {
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();

                    // Cancel all ongoing processing
                    ragProcessingControllers.forEach((controller, fileName) => {
                        controller.abort();
                    });
                    ragProcessingControllers.clear();

                    selectedFiles = [];
                    document.getElementById('file-input').value = '';
                    fileInfoContainer.classList.add('d-none');
                    fileNameEl.innerHTML = '';

                    // Clear the Browser RAG database when removing files
                    if (isClientSideRagEnabled && browserRetriever) {
                        browserRetriever.clearAllDocuments();
                    }
                });
            }
        }, 0);
    } else {
        fileInfoContainer.classList.add('d-none');
        fileNameEl.innerHTML = '';
    }
});

// Process multiple files with Browser RAG efficiently
async function processFilesWithRag(files) {
    if (!isClientSideRagEnabled || !browserRetriever || !files || files.length === 0) {
        return { success: false, error: "RAG not enabled or no files selected" };
    }

    const fileNameEl = document.getElementById('file-name');
    const results = [];
    let totalChunks = 0;

    try {
        // Process files sequentially with requestIdleCallback to avoid blocking UI
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            
            // Wait for idle time before processing next file (non-blocking)
            await new Promise(resolve => {
                if (window.requestIdleCallback) {
                    requestIdleCallback(() => resolve(), { timeout: 100 });
                } else {
                    setTimeout(resolve, 10); // Fallback
                }
            });

            // Update UI to show current file being processed
            if (fileNameEl && fileNameEl.querySelector('.badge')) {
                const badgeEl = fileNameEl.querySelector('.badge');
                badgeEl.innerHTML = `
                    <i class="fa-solid fa-spinner fa-spin me-2"></i>
                    <span>Processing ${i + 1}/${files.length}: ${file.name.substring(0, 12)}...</span>
                `;
            }

            const result = await processSingleFileWithRag(file);
            results.push(result);
            
            if (result.success) {
                totalChunks += result.chunkCount || 0;
            }
        }

        // Update UI with final success indication
        if (fileNameEl && fileNameEl.querySelector('.badge')) {
            const badgeEl = fileNameEl.querySelector('.badge');
            const successCount = results.filter(r => r.success).length;
            badgeEl.innerHTML = `
                <i class="fa-solid fa-file me-2"></i>
                <span>${files.length} file${files.length > 1 ? 's' : ''}</span>
                <span class="ms-2 text-success small">
                    <i class="fa-solid fa-check me-1"></i>${successCount}/${files.length} (${totalChunks} chunks)
                </span>
                <button type="button" class="btn-close ms-2" aria-label="Remove files" id="remove-file-btn"></button>
            `;

            // Re-add the remove button event listener
            setTimeout(() => {
                const removeBtn = document.getElementById('remove-file-btn');
                if (removeBtn) {
                    removeBtn.addEventListener('click', () => {
                        selectedFiles = [];
                        document.getElementById('file-input').value = '';
                        document.getElementById('file-info-container').classList.add('d-none');
                        fileNameEl.innerHTML = '';
                        if (browserRetriever) browserRetriever.clearAllDocuments();
                    });
                }
            }, 0);
        }

        return { 
            success: true, 
            results,
            totalChunks,
            processedCount: results.filter(r => r.success).length
        };
    } catch (error) {
        console.error("Error processing files with Browser RAG:", error);
        return { success: false, error: error.message || "Unknown error" };
    }
}

// Process single file with Browser RAG - can be canceled
async function processSingleFileWithRag(file) {
    if (!isClientSideRagEnabled || !browserRetriever || !file) {
        return { success: false, error: "RAG not enabled or no file provided" };
    }

    try {
        // Create a new AbortController for this file
        const controller = new AbortController();
        ragProcessingControllers.set(file.name, controller);
        const signal = controller.signal;

        // Ingest file with cancellation support
        const result = await new Promise((resolve, reject) => {
            const processTask = browserRetriever.ingestFile(file);

            // Watch for cancellation signal
            signal.addEventListener('abort', () => {
                reject(new DOMException('Processing aborted by user', 'AbortError'));
            });

            // Resolve with the result from ingestFile
            processTask.then(resolve).catch(reject);
        });

        // Remove controller after successful completion
        ragProcessingControllers.delete(file.name);

        return result;
    } catch (error) {
        // Remove controller on error
        ragProcessingControllers.delete(file.name);

        // Check if this was a user-initiated abort
        if (error.name === 'AbortError') {
            console.log(`File processing canceled: ${file.name}`);
            return { success: false, error: "Canceled by user", fileName: file.name };
        }

        // Handle other errors
        console.error(`Error processing file ${file.name}:`, error);
        return { success: false, error: error.message || "Unknown error", fileName: file.name };
    }
}

// Helper function to convert file to base64 for server-side processing if needed
async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = error => reject(error);
    });
}

// Store references to original elements and functions
let originalSubmitRequest = null;
let originalSendButton = null;
let originalSendButtonHandler = null;

// Override the submitRequest function to add Privacy functionality
document.addEventListener('DOMContentLoaded', () => {
    // Wait for the page to fully load to ensure the original elements are defined
    setTimeout(() => {
        // Store original submit function
        if (typeof submitRequest === 'function') {
            originalSubmitRequest = submitRequest;
        }

        // Store original send button and its handler
        originalSendButton = document.getElementById('send-button');
        if (originalSendButton) {
            // Clone the original button to preserve its attributes and event listeners
            originalSendButtonHandler = originalSendButton.cloneNode(true);
        }

        // Apply initial state based on current RAG setting
        toggleRagController(isClientSideRagEnabled);

        console.log("RAG controller initialization complete");
    }, 100); // Small delay to ensure original elements are defined
});

// Update the RAG toggle event listener to also toggle controller
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        const ragToggle = document.getElementById('rag-toggle');
        if (ragToggle) {
            // Add the toggle controller functionality to the existing event listener
            // without replacing the original element
            ragToggle.addEventListener('change', function () {
                // Toggle between RAG and regular controllers
                toggleRagController(this.checked);
            });
        }
    }, 150);
});

// Function to toggle between regular and RAG controllers
function toggleRagController(enableRag) {
    const sendButtonContainer = document.getElementById('send-button-container');
    const currentSendButton = document.getElementById('send-button');

    if (!sendButtonContainer || !originalSendButtonHandler) {
        console.warn("Cannot toggle send controller - missing elements");
        return;
    }

    // Remove current button
    if (currentSendButton) {
        currentSendButton.remove();
    }

    if (enableRag) {
        // Create RAG-enabled send button
        const ragSendButton = document.createElement('button');
        ragSendButton.id = 'send-button';
        ragSendButton.className = originalSendButtonHandler.className;
        ragSendButton.innerHTML = originalSendButtonHandler.innerHTML;
        ragSendButton.type = 'button';

        // Add RAG-specific handler
        ragSendButton.addEventListener('click', handleRagSubmit);

        // Add tooltip to indicate RAG is active
        ragSendButton.title = "Send with local document context";

        // Add a small indicator to show RAG is active
        const ragIndicator = document.createElement('span');
        ragIndicator.className = 'position-absolute top-0 start-100 translate-middle badge rounded-pill bg-success';
        ragIndicator.style.fontSize = '0.5rem';
        ragIndicator.innerHTML = 'RAG';
        ragSendButton.style.position = 'relative';
        ragSendButton.appendChild(ragIndicator);

        // Append to container
        sendButtonContainer.appendChild(ragSendButton);
        console.log("RAG submit controller enabled");
    } else {
        // Restore original send button
        const newOriginalButton = originalSendButtonHandler.cloneNode(true);
        sendButtonContainer.appendChild(newOriginalButton);
        console.log("Original submit controller restored");
    }
}



