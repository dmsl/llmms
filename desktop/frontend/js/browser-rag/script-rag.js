// Initialize Browser RAG
let browserRetriever = null;
let isClientSideRagEnabled = false; // Initialize RAG state
let ragProcessingController = null; // Controller for cancelable file processing


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
                if (fileNameEl && selectedFile) {
                    updateFileUI(isClientSideRagEnabled);
                }

                console.log(`Local RAG ${isClientSideRagEnabled ? 'enabled' : 'disabled'}`);
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

// Listen for file selection
const fileInputElement = document.getElementById('file-input');
if (fileInputElement) {
    fileInputElement.addEventListener('change', async (event) => {
        selectedFile = event.target.files[0];
        const fileNameEl = document.getElementById('file-name');
        const fileInfoContainer = document.getElementById('file-info-container');

        if (selectedFile) {
            // Display the file name (truncate if too long)
            let fileName = selectedFile.name;
            if (fileName.length > 15) {
                fileName = fileName.substring(0, 12) + '...';
            }

            // Show file info - with a "Ready for processing" indicator
            fileNameEl.innerHTML = `
            <div class="badge ${isClientSideRagEnabled ? 'bg-success text-white' : 'bg-light text-dark'} d-flex align-items-center p-2 mb-2">
                <i class="fa-solid fa-file me-2"></i>
                <span>${fileName}</span>
                ${isClientSideRagEnabled ? '<span class="ms-2 small"><i class="fa-solid fa-circle-info me-1"></i></span>' : ''}
                <button type="button" class="btn-close ms-2" aria-label="Remove file" id="remove-file-btn"></button>
            </div>
            `;
            if (fileInfoContainer) fileInfoContainer.classList.remove('d-none');

            // Add event listener to the remove button
            setTimeout(() => {
                const removeBtn = document.getElementById('remove-file-btn');
                if (removeBtn) {
                    removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();

                    // If there's an ongoing processing, cancel it
                    if (ragProcessingController) {
                        ragProcessingController.abort();
                        ragProcessingController = null;
                    }

                    selectedFile = null;
                    document.getElementById('file-input').value = '';
                    fileInfoContainer.classList.add('d-none');
                    fileNameEl.innerHTML = '';

                    // Clear the Browser RAG database when removing the file
                        if (isClientSideRagEnabled && browserRetriever) {
                            browserRetriever.clearAllDocuments();
                        }
                    });
                }
            }, 0);
        } else {
            if (fileInfoContainer) fileInfoContainer.classList.add('d-none');
            fileNameEl.innerHTML = '';
        }
    });
}

// Process file with Browser RAG - now a separate function that can be canceled
async function processFileWithRag(file) {
    if (!isClientSideRagEnabled || !browserRetriever || !file) {
        return { success: false, error: "RAG not enabled or no file selected" };
    }

    const fileNameEl = document.getElementById('file-name');
    try {
        // Create a new AbortController for this processing task
        ragProcessingController = new AbortController();
        const signal = ragProcessingController.signal;

        // Show processing indicator with cancel button
        if (fileNameEl && fileNameEl.querySelector('.badge')) {
            const badgeEl = fileNameEl.querySelector('.badge');
            badgeEl.innerHTML = `
                <i class="fa-solid fa-file me-2"></i>
                <span>${file.name.length > 15 ? file.name.substring(0, 12) + '...' : file.name}</span>
                <span class="ms-2 text-muted small">
                    <i class="fa-solid fa-spinner fa-spin me-1"></i>
                </span>
                <button type="button" class="btn btn-sm btn-danger ms-2" id="cancel-processing-btn" style="font-size: 0.75rem;">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            `;

            // Add event listener for the cancel button
            document.getElementById('cancel-processing-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (ragProcessingController) {
                    ragProcessingController.abort();
                    ragProcessingController = null;

                    // Update UI to show canceled state
                    badgeEl.innerHTML = `
                        <i class="fa-solid fa-file me-2"></i>
                        <span>${file.name.length > 15 ? file.name.substring(0, 12) + '...' : file.name}</span>
                        <span class="ms-2 text-warning small">
                            <i class="fa-solid fa-exclamation-circle me-1"></i>Canceled
                        </span>
                        <button type="button" class="btn-close ms-2" aria-label="Remove file" id="remove-file-btn"></button>
                    `;

                    // Re-add the remove button event listener
                    setTimeout(() => {
                        const removeBtn = document.getElementById('remove-file-btn');
                        if (removeBtn) {
                            removeBtn.addEventListener('click', () => {
                                selectedFile = null;
                                document.getElementById('file-input').value = '';
                                document.getElementById('file-info-container').classList.add('d-none');
                                fileNameEl.innerHTML = '';
                                if (browserRetriever) browserRetriever.clearAllDocuments();
                            });
                        }
                    }, 0);
                }
            });
        }

        // Create a wrapper for ingestFile that can be cancelled
        const result = await new Promise((resolve, reject) => {
            const processTask = browserRetriever.ingestFile(file);

            // Watch for cancellation signal
            signal.addEventListener('abort', () => {
                reject(new DOMException('Processing aborted by user', 'AbortError'));
            });

            // Resolve with the result from ingestFile
            processTask.then(resolve).catch(reject);
        });

        // Reset controller after successful completion
        ragProcessingController = null;

        // Update UI with success indication
        if (fileNameEl && fileNameEl.querySelector('.badge')) {
            const badgeEl = fileNameEl.querySelector('.badge');
            badgeEl.innerHTML = `
                <i class="fa-solid fa-file me-2"></i>
                <span>${file.name.length > 15 ? file.name.substring(0, 12) + '...' : file.name}</span>
                <span class="ms-2 text-success small">
                    <i class="fa-solid fa-check me-1"></i>${result.chunkCount} chunks
                </span>
                <button type="button" class="btn-close ms-2" aria-label="Remove file" id="remove-file-btn"></button>
            `;

            // Re-add the remove button event listener
            setTimeout(() => {
                const removeBtn = document.getElementById('remove-file-btn');
                if (removeBtn) {
                    removeBtn.addEventListener('click', () => {
                        selectedFile = null;
                        document.getElementById('file-input').value = '';
                        document.getElementById('file-info-container').classList.add('d-none');
                        fileNameEl.innerHTML = '';
                        if (browserRetriever) browserRetriever.clearAllDocuments();
                    });
                }
            }, 0);
        }

        return result;
    } catch (error) {
        // Reset controller on error
        ragProcessingController = null;

        // Check if this was a user-initiated abort
        if (error.name === 'AbortError') {
            console.log("File processing was canceled by user");
            return { success: false, error: "Canceled by user" };
        }

        // Handle other errors
        console.error("Error processing file with Browser RAG:", error);

        // Update UI with error indication
        if (fileNameEl && fileNameEl.querySelector('.badge')) {
            const badgeEl = fileNameEl.querySelector('.badge');
            badgeEl.innerHTML = `
                <i class="fa-solid fa-file me-2"></i>
                <span>${file.name.length > 15 ? file.name.substring(0, 12) + '...' : file.name}</span>
                <span class="ms-2 text-danger small">
                    <i class="fa-solid fa-exclamation-triangle me-1"></i>Error
                </span>
                <button type="button" class="btn-close ms-2" aria-label="Remove file" id="remove-file-btn"></button>
            `;

            // Re-add the remove button event listener
            setTimeout(() => {
                const removeBtn = document.getElementById('remove-file-btn');
                if (removeBtn) {
                    removeBtn.addEventListener('click', () => {
                        selectedFile = null;
                        document.getElementById('file-input').value = '';
                        document.getElementById('file-info-container').classList.add('d-none');
                        fileNameEl.innerHTML = '';
                    });
                }
            }, 0);
        }

        return { success: false, error: error.message || "Unknown error" };
    }
} // Close the if (fileInputElement) block

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

// Override the submitRequest function to add local RAG functionality
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



