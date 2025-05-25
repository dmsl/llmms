// Track active streaming state
let isStreaming = false;
// Initialize tooltips if Bootstrap is available
if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });
}
// Settings object for advanced configuration
let settings = JSON.parse(sessionStorage.getItem('settings')) || {
    models: {},
    algorithmType: 'stepwise',
    queryMode: 'interactive',
    tokenAllocation: 1024,
    startTokens: 64,
    maxRounds: 10,
    weights: {
        alpha: 0.7,  // Weight for question similarity
        beta: 0.3    // Weight for inter-model consensus
    },
    earlyStoppingParams: {
        marginRatio: 0.5,
        minTokens: 10,
        dynamicMarginCoeff: 1.0
    },
    mabParams: {
        xploreCoeff: 0.3
    },
    otherParams: {
        embeddingModel: 'nomic-embed-text'
    },
};
const modelButton = document.getElementById('modelbutton');
const modelMenu = document.getElementById('modelmenu');
// Track active controller for aborting fetch requests
let activeController = null;
// Configuration for LLM-MS 
let llmMsConfig = JSON.parse(sessionStorage.getItem('llmMsConfig')) || {
    ALGORITHM_TYPE: 'stepwise', // 'stepwise' or 'mab'
    START_TOKENS: 64,
    MAX_ROUNDS: 10,
    MAX_TOKENS: 1024,
    ALPHA: 0.7,  // Weight for question similarity
    BETA: 0.3,   // Weight for inter-model consensus
    DYNAMIC_MARGIN_COEFF: 0.5,
    MODELS: [],
    XPLORE_COEFF: 0.3,
    EMBEDDING_MODEL: 'nomic-embed-text'
};
// Available models list
let availableModels = [];
let currentModel = 'LLM-MS-OUA'; // Default model selection
// Store current active message elements
let activeMessageElements = {
    container: null,
    content: null,
    modelInfo: null
};
// Load available models
fetchModels();
// Fetch available models from the server
async function fetchModels() {
    try {
        console.log('Fetching available models...');
        const response = await fetch('/get_models');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('Fetched models data:', data);
        if (data && Array.isArray(data.models)) {
            availableModels = data.models;
            availableModels = [
                { id: 'llama3.2:latest', name: 'Llama 3.2', context_length: 4096 },
                { id: 'mistral:latest', name: 'Mistral', context_length: 8192 },
                { id: 'qwen2.5:latest', name: 'Qwen 2.5', context_length: 8192 },

                { id: 'gemma2:latest', name: 'Gemma2', context_length: 8192 },
                { id: 'deepseek-r1:latest', name: 'Deepseek R1', context_length: 8192 }
            ];
            console.log('Models loaded successfully:', availableModels.length, 'models available');
            // Populate model dropdown
            populateModelMenu();
            // Update model checkboxes in advanced settings modal
            updateModelCheckboxes();
        } else {
            console.error('Invalid models data format:', data);
            throw new Error('Invalid models data format');
        }
    } catch (error) {
        console.error('Error fetching models:', error);
        // Add fallback models if fetch fails
        availableModels = [
            { id: 'llama3:8b', name: 'Llama 3 8B', context_length: 4096 },
            { id: 'mistral:7b', name: 'Mistral 7B', context_length: 8192 }
        ];
        console.log('Using fallback models:', availableModels);
        populateModelMenu();
        updateModelCheckboxes();
    }
}
// Update model checkboxes in the settings panel
function updateModelCheckboxes() {
    console.log('Updating model checkboxes with', availableModels.length, 'models');
    // First, find the container in the settings modal
    const modelCheckboxesContainer = document.querySelector('#models-dropdown-container');
    if (!modelCheckboxesContainer) {
        console.error('Model checkboxes container not found');
        return;
    }
    // Clear the loader and create dropdown structure if not exists
    modelCheckboxesContainer.innerHTML = `
            <div class="dropdown model-selection-dropdown w-100">
            <button class="btn btn-outline-secondary dropdown-toggle w-100" type="button" 
                id="availableModelsDropdown" data-bs-toggle="dropdown" aria-expanded="false">
                <span id="selected-models-count">0</span> Models Selected
                <div id="selected-models-display" class="small text-muted"></div>
            </button>
            <ul class="dropdown-menu model-dropdown-menu w-100" aria-labelledby="availableModelsDropdown">
                <li class="dropdown-header">Available Models</li>
                <li><hr class="dropdown-divider"></li>
            </ul>
            </div>
            <div class="d-flex justify-content-between align-items-center mt-2 w-100">
            <button id="selectAllModelsBtn" class="btn btn-sm btn-outline-secondary w-100">Select All</button>
            </div>
        `;
    //for later use
    // <button id="autoSelectModelsBtn" class="btn btn-sm btn-outline-primary">
    // <i class="fa fa-magic me-1"></i>Use Model Index to Pre-select Optimal Models</button>
    // Add checkboxes for available models
    const modelsDropdownMenu = modelCheckboxesContainer.querySelector('.model-dropdown-menu');
    if (!modelsDropdownMenu) {
        console.error('Models dropdown menu not found');
        return;
    }
    if (availableModels && availableModels.length > 0) {
        console.log('Adding', availableModels.length, 'models to dropdown');
        availableModels.forEach((model, index) => {
            const listItem = document.createElement('li');
            listItem.className = 'dropdown-item p-0';
            listItem.innerHTML = `
                    <div class="form-check dropdown-item-check d-flex justify-content-between align-items-center">
                        <label class="form-check-label py-1" for="model${index}">
                            ${model.name} 
                         </label>
                        <input class="form-check-input model-checkbox" 
                               type="checkbox" 
                               id="model${index}" 
                               data-model-id="${model.id}" 
                               data-model-name="${model.name}" 
                               checked>
                    </div>
                `;
            modelsDropdownMenu.appendChild(listItem);
        });
    } else {
        console.warn('No models available to populate dropdown');
        modelsDropdownMenu.innerHTML += `<li class="dropdown-item text-danger">No models available</li>`;
    }
    // Add event listeners for model selection
    const checkboxes = document.querySelectorAll('.model-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', updateSelectedModelsDisplay);
    });
    // Add functionality to select all button
    const selectAllBtn = document.getElementById('selectAllModelsBtn');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', function () {
            const checkboxes = document.querySelectorAll('.model-checkbox');
            const allChecked = Array.from(checkboxes).every(cb => cb.checked);
            checkboxes.forEach(checkbox => {
                checkbox.checked = !allChecked;
            });
            // Update button text
            this.textContent = allChecked ? 'Select All' : 'Deselect All';
            // Update display
            updateSelectedModelsDisplay();
        });
    }
    // Initial update of selected models display
    updateSelectedModelsDisplay();
    console.log('Model checkboxes setup completed');
}
// Function to update the display of selected models in the dropdown
function updateSelectedModelsDisplay() {
    const checkboxes = document.querySelectorAll('.model-checkbox');
    const selectedModelsCount = document.getElementById('selected-models-count');
    const selectedModelsDisplay = document.getElementById('selected-models-display');
    if (!selectedModelsCount || !selectedModelsDisplay) return;
    // Count selected models and get their names
    const selectedModels = [];
    checkboxes.forEach(checkbox => {
        if (checkbox.checked) {
            const modelName = checkbox.getAttribute('data-model-name') || checkbox.id;
            selectedModels.push(modelName);
        }
    });
    // Update the count
    selectedModelsCount.textContent = selectedModels.length;
    // Update the display with model names
    if (selectedModels.length === 0) {
        selectedModelsDisplay.textContent = 'No models selected';
    } else if (selectedModels.length <= 3) {
        // Show all model names if 3 or fewer
        selectedModelsDisplay.textContent = selectedModels.join(', ');
    } else {
        // Show first two and total count if more than 3
        selectedModelsDisplay.textContent = `${selectedModels[0]}, ${selectedModels[1]} & ${selectedModels.length - 2} more`;
    }
    // Update settings object if needed
    const modelSettings = {};
    checkboxes.forEach(checkbox => {
        if (checkbox.checked) {
            const modelId = checkbox.getAttribute('data-model-id');
            if (modelId) {
                const baseModelName = modelId.split(':')[0];
                modelSettings[baseModelName] = true;
            }
        }
    });
    // Cache model settings in memory (will be saved when user clicks save)
    if (typeof settings !== 'undefined') {
        settings.models = modelSettings;
    }
}
// Populate the model dropdown menu
function populateModelMenu() {
    modelMenu.innerHTML = '';
    modelMenu.innerHTML += `
                <li class="dropdown-header">Meta LLM Selection</li>
                <li><a class="dropdown-item" href="#" data-model="LLM-MS-OUA">LLM-MS-OUA </a></li>
                <li><a class="dropdown-item" href="#" data-model="LLM-MS-MAB">LLM-MS-MAB </a></li>
            `;
    // Add event listeners
    document.querySelectorAll('#modelmenu .dropdown-item').forEach(item => {
        item.addEventListener('click', function (e) {
            e.preventDefault();
            selectModel(this.getAttribute('data-model'));
        });
    });
}
// Handle model selection
function selectModel(modelId) {
    currentModel = modelId;
    modelButton.textContent = modelId;
    llmMsConfig.ALGORITHM_TYPE = modelId === 'LLM-MS-OUA' ? 'stepwise' : 'mab';
    sessionStorage.setItem('selectedModel', currentModel);
    sessionStorage.setItem('llmMsConfig', JSON.stringify(llmMsConfig));
}

function createStreamingMessage() {
    // Create a placeholder message that will be updated during streaming
    const messageElement = document.createElement('div');
    messageElement.className = 'message assistant-message streaming';
    messageElement.innerHTML = `
             <!--    <div class="message-header">
                    <div class="model-info">
                        <span class="model-name">LLM-MS (Streaming...)</span>
                        <span class="token-count">Processing</span>
                    </div>
                </div>
                <div class="message-content">
                    <p class="typing-indicator"><span>.</span><span>.</span><span>.</span></p>
                </div>
                <div class="llm-ms-progress">
                    <div class="progress">
                        <div class="progress-bar" role="progressbar" style="width: 0%"></div>
                    </div>
                    <div class="model-stats"></div>
                </div> -->
                <div class="models-container" style="padding-left: 2em;">
                    <h6 class="models-container-title">Model Responses</h6>
                    <div class="models-scroll-container">
                        <div class="models-row"></div>
                    </div>
                </div>
                <div class="best-model-response-container" style="padding-left: 2em;">
                    <h6 class="best-model-title">Best Model Response</h6>
                    <div class="best-model-content"></div>
                </div>
            `;
    scrollToBottom();
    return {
        container: messageElement,
        content: messageElement.querySelector('.message-content p'),
        modelInfo: messageElement.querySelector('.model-info'),
        progress: messageElement.querySelector('.progress-bar'),
        stats: messageElement.querySelector('.model-stats'),
        modelsRow: messageElement.querySelector('.models-row'),
        bestModelContent: messageElement.querySelector('.best-model-content'),
    };
}

function updateStreamingMessage(elements, text, modelInfo = null) {
    if (elements.content) {
        elements.content.innerHTML = markdownToHtml(text);
    }
    if (modelInfo && elements.modelInfo) {
        const modelNameEl = elements.modelInfo.querySelector('.model-name');
        const tokenCountEl = elements.modelInfo.querySelector('.token-count');
        if (modelNameEl && modelInfo.model) {
            modelNameEl.textContent = modelInfo.model;
        }
        if (tokenCountEl && modelInfo.tokens) {
            tokenCountEl.textContent = `${modelInfo.tokens} tokens`;
        }
    }
    // Also update best model content with the latest text
    if (elements.bestModelContent && text) {
        elements.bestModelContent.innerHTML = markdownToHtml(text);
    }
    scrollToBottom();
}

function updateModelResponse(elements, modelName, text, isActive = false, isError = false, metrics = null) {
    // Add or update the model in the models row
    if (!elements.modelsRow) return;

    // Look for existing model card
    let modelCard = elements.modelsRow.querySelector(`.model-card[data-model="${modelName}"]`);

    // If it doesn't exist, create it
    if (!modelCard) {
        modelCard = document.createElement('div');
        modelCard.className = `model-card ${isActive ? 'active-model-card' : ''} ${isError ? 'error-model-card' : ''}`;
        modelCard.setAttribute('data-model', modelName);
        modelCard.innerHTML = `
            <div class="model-card-header">
                <div class="d-flex justify-content-between align-items-center">
                    <span>${modelName}</span>
                    <div class="model-metrics-badge"></div>
                </div>
            </div>
            <div class="model-metrics-container d-none"></div>
            <div class="model-card-content"></div>
        `;
        elements.modelsRow.appendChild(modelCard);

        // Ensure the models container is visible
        // add class d-none to child if clicked using event listener
        const modelsContainer = elements.container.querySelector('.models-container');
        if (modelsContainer) {
            modelsContainer.style.display = 'block';

            modelsContainer.addEventListener('click', function (e) {
                const modelsScrollContainer = modelsContainer.querySelector('.models-scroll-container');
                if (modelsScrollContainer) {
                    modelsScrollContainer.classList.toggle('d-none');

                    // Also update the title to indicate expand/collapse state
                    const titleElement = modelsContainer.querySelector('.models-container-title');
                    if (titleElement) {
                        if (modelsScrollContainer.classList.contains('d-none')) {
                            titleElement.innerHTML = 'Model Responses <small>(click to expand)</small>';
                        } else {
                            titleElement.innerHTML = 'Model Responses <small>(click to collapse)</small>';
                        }
                    }
                }
            });
        }



    }

    // Update content if text is provided (don't overwrite with null or empty string)
    if (text) {
        const contentDiv = modelCard.querySelector('.model-card-content');
        if (contentDiv) {
            // Remove any <think> tags if present
            const cleanText = typeof text === 'string' ? text.replace(/<think>.*?<\/think>/g, '') : text;
            contentDiv.innerHTML = markdownToHtml(cleanText);

            // Store the current content in a data attribute for reference
            modelCard.setAttribute('data-content', cleanText);
        }
    }

    // Check if this model is completed (done=true)
    if (metrics && metrics.done === true) {
        // Mark this model as completed
        modelCard.setAttribute('data-completed', 'true');

        // Make this the active model if it's completed
        isActive = true;
    }

    // Update metrics if provided
    if (metrics) {
        updateModelCardMetrics(modelCard, metrics);

        // If this is a model_scored update, check if this is the new best model
        if (metrics.score !== undefined) {
            // Store the score on the card for comparison
            modelCard.setAttribute('data-score', metrics.score);

            // Find all model cards with scores and determine the best one
            findAndUpdateBestModel(elements);
            return; // Skip the standard active status update since we've handled it
        }
    }

    // Update error state if necessary
    if (isError) {
        modelCard.classList.add('error-model-card');
    } else {
        modelCard.classList.remove('error-model-card');
    }

    // Update active status if explicitly requested (for non-scoring updates)
    if (isActive) {
        // Remove active class from all cards
        Array.from(elements.modelsRow.querySelectorAll('.model-card')).forEach(card => {
            card.classList.remove('active-model-card');
        });

        // Add active class to current card
        modelCard.classList.add('active-model-card');

        // Update best model response with the current best model's content
        if (elements.bestModelContent) {
            const currentContent = modelCard.getAttribute('data-content');
            if (currentContent) {
                elements.bestModelContent.innerHTML = markdownToHtml(currentContent);
                elements.bestModelContent.setAttribute('data-model', modelName);
            }

            // Make sure the best model response container is visible
            const bestModelContainer = elements.container.querySelector('.best-model-response-container');
            if (bestModelContainer) {
                bestModelContainer.style.display = 'block';
                bestModelContainer.querySelector('.best-model-title').textContent = `Best Model: ${modelName}`;
            }
        }
    }

    scrollToBottom();
}

// New helper function to find the best model by score and update the UI
function findAndUpdateBestModel(elements) {
    // First check for any completed models (done=true)
    const completedCards = elements.modelsRow.querySelectorAll('.model-card[data-completed="true"]');

    // If we have a completed model, use that as the best model
    if (completedCards.length > 0) {
        let bestModelCard = completedCards[completedCards.length - 1]; // Use the last completed model

        // Remove active class from all cards
        Array.from(elements.modelsRow.querySelectorAll('.model-card')).forEach(card => {
            card.classList.remove('active-model-card');
        });

        // Add active class to best card
        bestModelCard.classList.add('active-model-card');

        // Update best model content
        if (elements.bestModelContent) {
            const bestModelName = bestModelCard.getAttribute('data-model');
            const currentContent = bestModelCard.getAttribute('data-content');

            if (currentContent) {
                elements.bestModelContent.innerHTML = markdownToHtml(currentContent);
                elements.bestModelContent.setAttribute('data-model', bestModelName);
            }

            // Update the best model title
            const bestModelContainer = elements.container.querySelector('.best-model-response-container');
            if (bestModelContainer) {
                bestModelContainer.style.display = 'block';
                bestModelContainer.querySelector('.best-model-title').textContent =
                    `Best Model: ${bestModelName} (Completed)`;
            }
        }

        return; // Exit early if we found and updated a completed model
    }

    // Fall back to score-based selection if no model is completed
    const allModelCards = elements.modelsRow.querySelectorAll('.model-card[data-score]');
    let highestScore = -Infinity;
    let bestModelCard = null;

    // Find the model with the highest score
    allModelCards.forEach(card => {
        const score = parseFloat(card.getAttribute('data-score'));
        if (!isNaN(score) && score > highestScore) {
            highestScore = score;
            bestModelCard = card;
        }
    });

    // If we found a best model, update the UI
    if (bestModelCard) {
        // Remove active class from all cards
        Array.from(elements.modelsRow.querySelectorAll('.model-card')).forEach(card => {
            card.classList.remove('active-model-card');
        });

        // Add active class to best card
        bestModelCard.classList.add('active-model-card');

        // Update best model content
        if (elements.bestModelContent) {
            const bestModelName = bestModelCard.getAttribute('data-model');
            const currentContent = bestModelCard.getAttribute('data-content');

            if (currentContent) {
                elements.bestModelContent.innerHTML = markdownToHtml(currentContent);
                elements.bestModelContent.setAttribute('data-model', bestModelName);
            }

            // Update the best model title with the score
            const bestModelContainer = elements.container.querySelector('.best-model-response-container');
            if (bestModelContainer) {
                bestModelContainer.style.display = 'block';
                bestModelContainer.querySelector('.best-model-title').textContent =
                    `Best Model: ${bestModelName} (Score: ${highestScore.toFixed(3)})`;
            }
        }
    }
}

function updateModelCardMetrics(modelCard, metrics) {
    if (!modelCard) return;

    const metricsContainer = modelCard.querySelector('.model-metrics-container');
    const metricsBadge = modelCard.querySelector('.model-metrics-badge');

    if (!metricsContainer || !metricsBadge) return;


    let badgeHtml = '';

    // Helper function to format numbers
    const formatNumber = (value) => {
        if (value === undefined || value === null) return 'N/A';
        if (typeof value === 'number') return value.toFixed(2);
        if (typeof value === 'string' && !isNaN(parseFloat(value))) {
            return parseFloat(value).toFixed(2);
        }
        return value.toString();
    };

    const modelName = modelCard.getAttribute('data-model');

    // Extract model-specific metrics
    const hasScore = metrics.score !== undefined ||
        (metrics.similarity_scores && metrics.similarity_scores[modelName] !== undefined) ||
        (metrics.model_scored_data && metrics.model_scored_data[modelName] !== undefined);

    // Get the specific score/reward for this model
    let score = null;


    if (hasScore) {
        score = metrics.score ||
            (metrics.similarity_scores ? metrics.similarity_scores[modelName] : null) ||
            (metrics.model_scored_data && metrics.model_scored_data[modelName] ? metrics.model_scored_data[modelName].score : null);
    }

    // Build the metrics display
    if (score !== null) {

        badgeHtml = `<span class="score-badge">${formatNumber(score)}</span>`;
    }


    if (badgeHtml) {
        metricsBadge.innerHTML = badgeHtml;
        metricsBadge.classList.remove('d-none');
    }
}

function updateStreamingProgress(elements, progress, modelStats = null) {
    if (elements.progress) {
        elements.progress.style.width = `${progress}%`;
    }
    if (modelStats && elements.stats) {
        let statsHtml = '';
        for (const [model, stats] of Object.entries(modelStats)) {
            statsHtml += `<div><strong>${model}:</strong> Score: ${stats.score.toFixed(2)} | ${stats.done ? '✓' : '...'}</div>`;
        }
        elements.stats.innerHTML = statsHtml;
    }
}

function finalizeStreamingMessage(elements, text, modelInfo = null) {
    // Remove streaming class and progress indicators
    if (elements.container) {
        elements.container.classList.remove('streaming');
        const progressDiv = elements.container.querySelector('.llm-ms-progress');
        if (progressDiv) {
            progressDiv.remove();
        }

        // Keep models container visible regardless of model count
        const modelsContainer = elements.container.querySelector('.models-container');
        if (modelsContainer) {
            modelsContainer.style.display = 'block';
        }

        // Final check to ensure the best model is displayed correctly
        // First check if any model is marked as completed
        const completedCards = elements.modelsRow.querySelectorAll('.model-card[data-completed="true"]');
        if (completedCards.length > 0) {
            // Use the last completed model as the final model
            const finalModelCard = completedCards[completedCards.length - 1];
            const finalModelName = finalModelCard.getAttribute('data-model');
            const finalModelContent = finalModelCard.getAttribute('data-content');

            // Update the best model content
            if (elements.bestModelContent && finalModelContent) {
                elements.bestModelContent.innerHTML = markdownToHtml(finalModelContent);
                elements.bestModelContent.setAttribute('data-model', finalModelName);

                // Update the best model title
                const bestModelContainer = elements.container.querySelector('.best-model-response-container');
                if (bestModelContainer) {
                    bestModelContainer.style.display = 'block';
                    bestModelContainer.querySelector('.best-model-title').textContent = `Best Model: ${finalModelName} (Completed)`;
                }
            }

            // Update modelInfo for the response
            if (modelInfo) {
                modelInfo.model = finalModelName;
            }
        } else {
            // Fall back to regular best model detection
            findAndUpdateBestModel(elements);
        }
    }

    updateStreamingMessage(elements, text, modelInfo);
}

function markdownToHtml(markdown) {
    // Use marked library if available, otherwise basic formatting
    if (window.marked) {
        return marked.parse(markdown);
    } else {
        // Basic formatting - replace new lines with breaks
        return markdown.replace(/\n/g, '<br>');
    }
}

function scrollToBottom() {
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

/**
 * Extract complete JSON objects from a string that might contain multiple concatenated JSON objects.
 * @param {string} buffer - The input string potentially containing multiple JSON objects.
 * @returns {Object} - Object with 'objects' array containing extracted JSON strings and 'remainder' string.
 */
function extractJsonObjects(buffer) {
    const jsons = [];
    let searchFrom = 0;

    while (searchFrom < buffer.length) {
        const startIndex = buffer.indexOf('{', searchFrom);
        if (startIndex === -1) {
            // No more '{' found, the rest of the buffer is the remainder
            break;
        }

        let balance = 0;
        let endIndex = -1;
        for (let i = startIndex; i < buffer.length; i++) {
            if (buffer[i] === '{') {
                balance++;
            } else if (buffer[i] === '}') {
                if (balance > 0) { // Ensure we only decrement if braces were open
                    balance--;
                }
                if (balance === 0) { // Check if balance is zero only after decrementing
                    endIndex = i;
                    break;
                }
            }
        }

        if (endIndex !== -1) {
            // Found a complete JSON object string
            const jsonString = buffer.substring(startIndex, endIndex + 1);
            jsons.push(jsonString);
            searchFrom = endIndex + 1; // Continue search after this object
        } else {
            // Incomplete JSON object at the end of the buffer
            // The part from startIndex onwards is the remainder for the next call
            searchFrom = startIndex;
            break;
        }
    }
    return { objects: jsons, remainder: buffer.substring(searchFrom) };
}

async function sendMessage() {
    console.log("sendMessage: Starting submission process...");
    // Ensure a session exists.
    if (!sessionName) {
        console.log("submitRequest: No session found. Creating a new session.");
        createNewSession();
    }
    // Retrieve user input and clear the textbox.
    const inputEl = document.getElementById('user-input');
    const input = inputEl.value.trim();
    inputEl.value = '';
    if (!input) return;
    console.log("submitRequest: User input received:", input);
    // Update chat history and UI.
    const userMessage = { role: 'user', content: input };
    chatHistory.push(userMessage);
    chatmodelhistory.push('user');
    appendUserMessage(input);
    setTimeout(() => saveChatMemory(), 0);
    const sessionData = JSON.parse(localStorage.getItem(CHAT_PREFIX + sessionName)) || {};
    const hiddenHistory = sessionData.hiddenHistory || [];
    const messagesFromLastSummarized = chatHistory.slice(lastSummarizedIndex);
    const modelContextLimits = JSON.parse(localStorage.getItem('modelContextLimits') || '{}');
    let maxContextTokens = modelContextLimits[selectedModel] || 2048;
    // Calculate total tokens in the message history.
    const countTokens = text => text ? text.split(/\s+/).length : 0;
    const totalTokens = messagesFromLastSummarized.reduce((count, message) => {
        return count + countTokens(message?.content);
    }, 0) + (Array.isArray(hiddenHistory) ? hiddenHistory.reduce((count, message) => {
        return count + countTokens(message?.content);
    }, 0) : 0);
    console.log("submitRequest: Total tokens calculated:", totalTokens);
    // Manage history if needed (do not wait for completion).
    let historyPromise;
    if (totalTokens > maxContextTokens) {
        console.log("submitRequest: Total tokens exceed limit. Managing chat history...");
        historyPromise = manageChatHistory();
    }
    const hiddenHistoryMessage = (sessionData.hiddenHistory && Object.keys(sessionData.hiddenHistory).length > 0)
        ? sessionData.hiddenHistory
        : null;
    // Build the chat container UI for streaming the response.
    const chatContainer = document.getElementById('chat-history');
    const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
    let responseText = "";
    // create a signal to abort the request if needed
    const controller = new AbortController();
    const signal = controller.signal;
    // Start streaming indicator
    isStreaming = true;

    const streamingElements = createStreamingMessage();
    chatContainer.appendChild(streamingElements.container);
    activeMessageElements = streamingElements;

    try {
        // Use the LLM-MS API endpoint
        const algorithmType = currentModel === 'LLM-MS-OUA' ? 'stepwise' : 'mab';
        const apiEndpoint = '/api/send_message_llmms';
        // Create a config object with only the parameters needed for the selected algorithm
        const configToSend = {
            ALGORITHM_TYPE: llmMsConfig.ALGORITHM_TYPE
        };
        // Add the appropriate parameters based on algorithm type
        if (algorithmType === 'stepwise') {
            // OUA parameters
            configToSend.START_TOKENS = llmMsConfig.START_TOKENS || 64;
            configToSend.MAX_ROUNDS = llmMsConfig.MAX_ROUNDS || 10;
            configToSend.MAX_TOKENS = llmMsConfig.MAX_TOKENS || 1024;
            configToSend.ALPHA = llmMsConfig.ALPHA || 0.7;
            configToSend.BETA = llmMsConfig.BETA || 0.3;
            configToSend.DYNAMIC_MARGIN_COEFF = llmMsConfig.DYNAMIC_MARGIN_COEFF || 0.5;
            configToSend.EMBEDDING_MODEL = llmMsConfig.EMBEDDING_MODEL || 'nomic-embed-text';
            configToSend.MODELS = llmMsConfig.MODELS || [];
        } else {
            // MAB parameters
            configToSend.MAX_ROUNDS = llmMsConfig.MAX_ROUNDS || 50;
            configToSend.MAX_TOKENS = llmMsConfig.MAX_TOKENS || 1024;
            configToSend.XPLORE_COEFF = llmMsConfig.XPLORE_COEFF || 0.3;
            configToSend.EMBEDDING_MODEL = llmMsConfig.EMBEDDING_MODEL || 'nomic-embed-text';
            configToSend.MODELS = llmMsConfig.MODELS || [];
        }
        console.log("submitRequest: Sending request to API endpoint:", apiEndpoint);
        console.log("submitRequest: Request body:", {
            messages: hiddenHistoryMessage ? [hiddenHistoryMessage, ...messagesFromLastSummarized] : messagesFromLastSummarized,
            algorithm_type: algorithmType,
            config: configToSend,
            system_prompt: "You are a helpful assistant."
        });
        // Prepare request body
        const requestBody = {
            messages: hiddenHistoryMessage ? [hiddenHistoryMessage, ...messagesFromLastSummarized] : messagesFromLastSummarized,
            algorithm_type: algorithmType,
            config: configToSend,
            system_prompt: "You are a helpful assistant."
        };
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
            signal: signal
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        // Ensure response.body is readable
        if (!response.body) {
            throw new Error('ReadableStream not supported in this browser.');
        }
        const reader = response.body.getReader();
        let jsonBuffer = '';
        const decoder = new TextDecoder(); // Assuming UTF-8

        activeMessageElements = createStreamingMessage(); // Create message elements

        try { // Added try-catch for the stream reading loop
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    isStreaming = false;
                    if (activeController === controller) activeController = null;

                    // Process any remaining data in jsonBuffer
                    if (jsonBuffer.trim().length > 0) {
                        const finalExtraction = extractJsonObjects(jsonBuffer);
                        for (const jsonObjString of finalExtraction.objects) {
                            try {
                                const data = JSON.parse(jsonObjString);
                                // Process data similar to how it's done in the main loop
                                // This is a simplified representation; actual processing logic should be reused
                                if (data.status === 'error' && activeMessageElements.content) {
                                    updateModelResponse(activeMessageElements, "Error", `<p class="text-danger">Error: ${data.error}</p>`, true, true);
                                } else if (data.status === 'final_result' && activeMessageElements.content) {
                                    finalizeStreamingMessage(activeMessageElements, markdownToHtml(data.message || data.completion || ""), data.model_info || "Completed");
                                } else if (activeMessageElements.content) { // Handle other potential statuses
                                    // Fallback for other data types if necessary
                                    updateStreamingMessage(activeMessageElements, activeMessageElements.content.innerHTML + markdownToHtml(data.message || JSON.stringify(data)));
                                }
                                // Add more comprehensive status handling here if needed for final chunks
                            } catch (e) {
                                console.error("Error parsing JSON object from final buffer:", e, jsonObjString);
                                if (activeMessageElements.content) {
                                    updateModelResponse(activeMessageElements, "Error", `<p class="text-danger">Malformed data at stream end.</p>`, true, true);
                                }
                            }
                        }
                        if (finalExtraction.remainder.trim().length > 0) {
                            console.warn("Stream ended with non-JSON remainder:", finalExtraction.remainder);
                            if (activeMessageElements.content && !finalExtraction.objects.length) {
                                updateModelResponse(activeMessageElements, "Warning", `<p class="text-warning">Stream ended with unprocessed data.</p>`, true, false);
                            }
                        }
                    }

                    if (activeMessageElements.container) {
                        findAndUpdateBestModel(activeMessageElements);
                    }
                    // Reset UI (send button, input field)
                    sendButton.classList.remove('disabled');
                    sendButton.innerHTML = '<i class="fa fa-arrow-up" aria-hidden="true"></i>';
                    document.getElementById('user-input').disabled = false;
                    document.getElementById('user-input').focus();
                    break; // Exit the while loop
                }

                jsonBuffer += decoder.decode(value, { stream: true });
                const result = extractJsonObjects(jsonBuffer);

                for (const jsonObjString of result.objects) {
                    try {
                        const data = JSON.parse(jsonObjString);

                        // Existing logic for handling different data.status
                        if (data.status === 'initialized') {
                            // console.log("Streaming initialized with config:", data.config);
                            if (activeMessageElements.modelInfo) {
                                // activeMessageElements.modelInfo.innerHTML = `<small class="text-muted">Initializing with ${data.config.models ? data.config.models.join(', ') : 'default models'}...</small>`;
                            }
                        } else if (data.status === 'model_progress' || data.status === 'model_update') {
                            if (activeMessageElements.container) {
                                updateModelResponse(
                                    activeMessageElements,
                                    data.model_name,
                                    markdownToHtml(data.output),
                                    data.is_active || false,
                                    false,
                                    data.metrics
                                );
                            }
                        } else if (data.status === 'model_finished') {
                            if (activeMessageElements.container) {
                                updateModelResponse(
                                    activeMessageElements,
                                    data.model_name,
                                    markdownToHtml(data.output),
                                    false, // Not active anymore
                                    false,
                                    data.metrics
                                );
                                // console.log(`${data.model_name} finished. Reason: ${data.reason}`);
                            }
                        } else if (data.status === 'partial_result' || data.status === 'interim_result') {
                            if (activeMessageElements.content) {
                                // Main content update
                                updateStreamingMessage(activeMessageElements, markdownToHtml(data.message), data.model_info);
                            }
                        } else if (data.status === 'final_result') {
                            if (activeMessageElements.content) {
                                finalizeStreamingMessage(activeMessageElements, markdownToHtml(data.message || data.completion || ""), data.model_info || "Completed");
                                // console.log("Final result:", data.message);
                            }
                            // The loop will break on the next 'done' signal if this is truly final.
                            // Or, if the server sends 'done:true' with final_result, it could be handled here too.
                        } else if (data.status === 'error') {
                            console.error("Streaming error from server:", data.error);
                            if (activeMessageElements.content) {
                                updateModelResponse(activeMessageElements, "Error", `<p class="text-danger">Server error: ${data.error}</p>`, true, true);
                            }
                            // Optionally, abort streaming if server indicates a fatal error
                            if (data.done && activeController) {
                                activeController.abort();
                            }
                        } else {
                            // console.log("Unknown data status:", data);
                            // Fallback for unknown status, update main content
                            if (activeMessageElements.content && data.message) {
                                updateStreamingMessage(activeMessageElements, activeMessageElements.content.innerHTML + markdownToHtml(data.message));
                            }
                        }
                    } catch (e) {
                        console.error("Error parsing JSON object from stream:", e, jsonObjString);
                        // Avoid flooding with errors for continuously malformed streams
                    }
                }
                jsonBuffer = result.remainder;
            }
        } catch (streamError) { // Catch errors from reader.read() or decoder
            console.error("Error reading or decoding stream:", streamError);
            isStreaming = false;
            if (activeController === controller) activeController = null;
            if (activeMessageElements.content) {
                updateModelResponse(activeMessageElements, "Error", `<p class="text-danger">Stream connection error: ${streamError.message}</p>`, true, true);
            }
            // Reset UI
            sendButton.classList.remove('disabled');
            sendButton.innerHTML = '<i class="fa fa-arrow-up" aria-hidden="true"></i>';
            document.getElementById('user-input').disabled = false;
            document.getElementById('user-input').focus();
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Request was aborted');
        } else {
            console.error('Error:', error);
            updateStreamingMessage(streamingElements, 'Error: ' + error.message);
            finalizeStreamingMessage(streamingElements, 'Error: ' + error.message, { model: 'Error', tokens: 0 });
        }
    } finally {
        isStreaming = false;
        activeController = null;
    }
}
