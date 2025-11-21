let sessionName = null;
let selectedModel = localStorage.getItem('selectedModel') || 'null';
const CHAT_PREFIX = 'chat_'; // Prefix for identifying chat sessions in localStorage
// Define the base URL for the API by decoding a Base64 string
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
    startTokens: 1024,
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
    START_TOKENS: 1024,
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
        const response = await fetch('/api/get_models');
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
  // Guard against null/undefined or non-string inputs
  if (typeof markdown !== 'string') {
    return '';
  }

  // If marked is available, try to parse
  if (window.marked && typeof marked.parse === 'function') {
    try {
      return marked.parse(markdown);
    } catch (e) {
      console.warn('marked.parse failed, falling back to simple newline replacement:', e);
      // fall through to the basic formatter
    }
  }

  // Basic fallback: escape HTML then convert newlines to <br>
  const escaped = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\n/g, '<br>');
}


function scrollToBottom() {
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

/**
 * Extract complete JSON objects from a string that might contain multiple concatenated JSON objects.
 * @param {string} str - The input string potentially containing multiple JSON objects.
 * @returns {Object} - Object with 'objects' array containing extracted JSON strings and 'remainder' string.
 */
function extractJsonObjects(str) {
    const objects = [];
    let bracketCount = 0;
    let startIndex = -1;
    let lastCompleteIndex = 0; // Track the end index of the last complete JSON object.

    // Handle empty or null input
    if (!str) return { objects: [], remainder: '' };

    // Handle potential escape sequences properly and track nested JSON objects
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        // Detect opening bracket (only if not escaped)
        if (char === '{' && (i === 0 || str[i - 1] !== '\\')) {
            if (bracketCount === 0) {
                startIndex = i;
            }
            bracketCount++;
        }
        // Detect closing bracket (only if not escaped)
        else if (char === '}' && (i === 0 || str[i - 1] !== '\\')) {
            bracketCount--;
            if (bracketCount === 0 && startIndex !== -1) {
                // Found a complete JSON object
                try {
                    const jsonStr = str.substring(startIndex, i + 1);
                    // Verify this is valid JSON before adding
                    JSON.parse(jsonStr);
                    objects.push(jsonStr);
                    lastCompleteIndex = i + 1;
                } catch (e) {
                    console.warn('Invalid JSON found:', jsonStr.substring(0, 100) + '...');
                }
                startIndex = -1;
            }
        }
    }

    const remainder = str.substring(lastCompleteIndex);
    return { objects, remainder };
}

// Initialize by loading saved model preference if available
const savedModel = sessionStorage.getItem('selectedModel');
if (savedModel) {
    selectModel(savedModel);
}
// Save settings
document.getElementById('saveAdvancedSettings').addEventListener('click', function () {
    // Get active models as array from dynamic checkboxes
    const modelCheckboxes = document.querySelectorAll('.model-checkbox');
    const activeModels = [];
    const modelSettings = {};
    if (modelCheckboxes.length > 0) {
        modelCheckboxes.forEach(checkbox => {
            if (checkbox.checked) {
                const modelId = checkbox.getAttribute('data-model-id');
                if (modelId) {
                    const baseModelName = modelId.split(':')[0];
                    activeModels.push(baseModelName);
                    modelSettings[baseModelName] = true;
                }
            }
        });
    } else {
        // Fallback to legacy checkboxes
        if (document.getElementById('modelLlama') && document.getElementById('modelLlama').checked) {
            activeModels.push("llama3.1");
            modelSettings.llama = true;
        }
        if (document.getElementById('modelMistral') && document.getElementById('modelMistral').checked) {
            activeModels.push("mistral");
            modelSettings.mistral = true;
        }
        if (document.getElementById('modelQwen') && document.getElementById('modelQwen').checked) {
            activeModels.push("qwen2.5");
            modelSettings.qwen = true;
        }
    }
    // Update the settings object with the collected model settings
    settings.models = modelSettings;
    // Get the selected algorithm type
    const algorithmType = document.querySelector('input[name="algorithmType"]:checked').value;
    // Calculate the early stopping margin ratio based on the number of selected models
    // Following the formula from Python: 1 * math.log2(len(MODELS))
    const numModels = Object.keys(settings.models).length || 1;
    const calculatedMarginRatio = 1 * Math.log2(numModels || 2);
    // Different settings for different algorithms
    if (algorithmType === 'stepwise') {
        // Get alpha/beta weights from UI if they exist, or use defaults
        const alphaWeight = document.getElementById('alphaWeight') ?
            parseFloat(document.getElementById('alphaWeight').value) : 0.7;
        const betaWeight = document.getElementById('betaWeight') ?
            parseFloat(document.getElementById('betaWeight').value) : 0.3;
        // Update settings with UI values
        settings.weights.alpha = alphaWeight;
        settings.weights.beta = betaWeight;
        // Update llmMsConfig for Stepwise/OUA algorithm
        llmMsConfig = {
            ALGORITHM_TYPE: 'stepwise',
            MODELS: activeModels,
            START_TOKENS: parseInt(document.getElementById('tokenAllocation').value),
            MAX_ROUNDS: 10,
            MAX_TOKENS: parseInt(document.getElementById('tokenAllocation').value),
            ALPHA: settings.weights.alpha,
            BETA: settings.weights.beta,
            DYNAMIC_MARGIN_COEFF: calculatedMarginRatio || parseFloat(document.getElementById('earlyStoppingMargin').value)
                || 0.5,
            EMBEDDING_MODEL: document.getElementById('embeddingModel').value,
        };
    } else {
        // MAB algorithm configuration
        llmMsConfig = {
            ALGORITHM_TYPE: 'mab',
            MODELS: activeModels,
            MAX_ROUNDS: parseInt(document.getElementById('maxRounds').value),
            MAX_TOKENS: parseInt(document.getElementById('tokenAllocation').value),
            XPLORE_COEFF: parseFloat(document.getElementById('xploreCoeff').value)
        };
    }
    // Save to session storage
    sessionStorage.setItem('settings', JSON.stringify(settings));
    sessionStorage.setItem('llmMsConfig', JSON.stringify(llmMsConfig));
});
// Add CSS styles for better dropdown checkboxes and UI elements
(function addStreamingStyles() {
    const style = document.createElement('style');
    style.textContent = `
            .message.streaming .typing-indicator span {
                animation: typing 1s infinite;
                opacity: 0.3;
            }
            .message.streaming .typing-indicator span:nth-child(1) {
                animation-delay: 0s;
            }
            .message.streaming .typing-indicator span:nth-child(2) {
                animation-delay: 0.3s;
            }
            .message.streaming .typing-indicator span:nth-child(3) {
                animation-delay: 0.6s;
            }
            @keyframes typing {
                0% { opacity: 0.3; }
                50% { opacity: 1; }
                100% { opacity: 0.3; }
            }
            .llm-ms-progress {
                padding: 10px 0;
            }
            .model-stats {
                font-size: 0.8em;
                margin-top: 5px;
            }
            .active-session {
                background-color: #e9ecef;
                border-left: 3px solid #007bff;
            }
            .chat-session {
                cursor: pointer;
                transition: background-color 0.2s;
            }
            .chat-session:hover {
                background-color: #f8f9fa;
            }
            .model-info {
                display: flex;
                justify-content: space-between;
                font-size: 0.8em;
                color: #6c757d;
                margin-bottom: 5px;
            }
            /* Model dropdown styles */
            .model-selection-dropdown .dropdown-menu {
                padding: 8px 0;
                max-height: 250px;
                overflow-y: auto;
            }
            .dropdown-item-check {
                padding: 0.25rem 0.5rem;
                margin: 0;
                width: 100%;
            }
            .dropdown-item-check:hover {
                background-color: #f8f9fa;
            }
            .dropdown-item-check label {
                cursor: pointer;
                display: block;
                width: 100%;
            }
            .model-dropdown-menu .dropdown-item {
                padding: 0;
            }
            #selected-models-display {
                max-width: 100%;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            
            /* Models container and row styles */
            .models-container {
                margin-top: 15px;
                border-top: 1px solid #dee2e6;
                padding-top: 10px;
            }
            
            .models-container-title {
                font-size: 0.9rem;
                color: #6c757d;
                margin-bottom: 8px;
                font-weight: bold;
            }
            
            .models-scroll-container {
                overflow-x: auto;
                padding-bottom: 5px;
                margin-bottom: 5px;
                -webkit-overflow-scrolling: touch;
                scrollbar-width: thin;
            }
            
            .models-row {
                display: flex;
                flex-wrap: nowrap;
                gap: 10px;
                padding-bottom: 5px;
                min-width: min-content;
            }
            
            .model-card {
                min-width: 200px;
                max-width: 300px;
                min-height: 80px;
                height: auto;
                border: 1px solid #dee2e6;
                border-radius: 8px;
                padding: 10px;
                margin-bottom: 1rem;
                background-color: #f8f9fa;
                flex-shrink: 0;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                transition: all 0.2s ease;
            }
            
            .model-card:hover {
                border-color: #adb5bd;
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            }
            
            .model-card-header {
                font-weight: bold;
                font-size: 0.9rem;
                padding-bottom: 5px;
                border-bottom: 1px solid #dee2e6;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                cursor: pointer;
            }
            
            .model-card-header:hover {
                background-color: #f0f0f0;
            }
            
            .model-metrics-container {
                font-size: 0.8rem;
                padding: 5px 0;
                margin-top: 3px;
                margin-bottom: 3px;
                border-bottom: 1px dotted #dee2e6;
            }
            
            .model-metric-row {
                display: flex;
                justify-content: space-between;
                padding: 2px 4px;
            }
            
            .model-metrics-badge {
                font-size: 0.75rem;
                padding: 1px 5px;
                background-color: #e9ecef;
                border-radius: 10px;
                color: #495057;
            }
            
            .score-badge {
                background-color: #28a745;
                color: white;
                padding: 1px 6px;
                border-radius: 10px;
                font-size: 0.75rem;
            }
            
            .active-model-card .score-badge {
                background-color: #198754;
            }
            
            .model-card-content {
                font-size: 0.8rem;
                overflow: hidden;
                flex-grow: 1;
                margin-top: 5px;
                color: #495057;
                overflow-y: auto;
                padding-bottom: 1rem;
            }
            
            .active-model-card {
                border-left: 3px solid #28a745;
                background-color: #f0f9f0;
            }
            
            /* Best model response container */
            .best-model-response-container {
                margin-top: 15px;
                border-top: 1px solid #dee2e6;
                padding-top: 10px;
            }
            
            .best-model-title {
                font-size: 0.9rem;
                color: #28a745;
                margin-bottom: 8px;
                font-weight: bold;
            }
            
            .best-model-content {
                background-color: #f0f9f0;
                border-left: 3px solid #28a745;
                padding: 10px;
                border-radius: 4px;
            }
            
            /* Improve scrollbar appearance */
            .models-scroll-container::-webkit-scrollbar {
                height: 6px;
            }
            
            .models-scroll-container::-webkit-scrollbar-thumb {
                background-color: #ccc;
                border-radius: 6px;
            }
            
            .models-scroll-container::-webkit-scrollbar-track {
                background-color: #f1f1f1;
            }
            
            /* Add scroll indicators */
            .models-scroll-container {
                position: relative;
            }
            
            .models-scroll-container::after {
                content: '';
                position: absolute;
                top: 0;
                right: 0;
                bottom: 0;
                width: 30px;
                background: linear-gradient(to right, rgba(255,255,255,0), rgba(255,255,255,0.8));
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.2s;
            }
            
            .models-scroll-container:hover::after {
                opacity: 1;
            }
            
            /* Metrics table styles */
            .metrics-table {
                width: 100%;
                font-size: 0.85rem;
                border-collapse: separate;
                border-spacing: 0;
                margin-bottom: 10px;
            }
            
            .metrics-row {
                display: flex;
                justify-content: space-between;
                padding: 4px 8px;
                border-bottom: 1px solid rgba(0,0,0,0.05);
            }
            
            .metrics-row.header {
                font-weight: bold;
                background-color: rgba(0,0,0,0.03);
                border-bottom: 1px solid rgba(0,0,0,0.1);
                margin-top: 8px;
            }
            
            .metrics-row:last-child {
                border-bottom: none;
            }
            
            .metrics-title {
                font-size: 0.9rem;
                color: #6c757d;
                margin-bottom: 8px;
                font-weight: bold;
            }
            
            .metrics-container {
                margin-top: 15px;
                border-top: 1px solid #dee2e6;
                padding-top: 10px;
                background-color: #f8f9fa;
                border-radius: 4px;
                padding: 10px;
            }
            
            .highlight-score {
                font-weight: bold;
                color: #28a745;
            }
            
            /* Error model card styles */
            .error-model-card {
                border-left: 3px solid #dc3545;
                background-color: #fff8f8;
            }
            
            .error-model-card .model-card-content {
                color: #dc3545;
            }
            
            /* Add model status indicator */
            .model-status-indicator {
                display: inline-block;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                margin-right: 5px;
            }
            
            .model-status-indicator.active {
                background-color: #28a745;
            }
            
            .model-status-indicator.error {
                background-color: #dc3545;
            }
            
            .model-status-indicator.processing {
                background-color: #ffc107;
                animation: pulse 2s infinite;
            }
            
            @keyframes pulse {
                0% { opacity: 0.5; }
                50% { opacity: 1; }
                100% { opacity: 0.5; }
            }
            
            /* Metrics display improvements */
            .metrics-table {
                width: 100%;
                font-size: 0.85rem;
                border-collapse: separate;
                border-spacing: 0;
                margin-bottom: 15px;
                background-color: #f8f9fa;
                border-radius: 4px;
            }
        `;
    document.head.appendChild(style);
})();
// Add these initialization functions for advanced settings modal
function initAdvancedSettingsModal() {
    // Algorithm type toggle
    const algorithmStepwise = document.getElementById('algorithmStepwise');
    const algorithmMAB = document.getElementById('algorithmMAB');
    const mabSettingsContainer = document.getElementById('mabSettingsContainer');
    const dynamicMarginContainer = document.getElementById('dynamicMarginContainer');
    const maxRoundsField = document.getElementById('maxRounds');
    const startTokensField = document.getElementById('startTokens');
    const xploreCoeffField = document.getElementById('xploreCoeff');
    const maxRoundsLabel = maxRoundsField ? maxRoundsField.previousElementSibling : null;

    if (algorithmStepwise) {
        algorithmStepwise.addEventListener('change', function () {
            if (this.checked) {
                if (mabSettingsContainer) mabSettingsContainer.classList.add('d-none');
                if (dynamicMarginContainer) dynamicMarginContainer.classList.remove('d-none');
                if (startTokensField) startTokensField.parentElement.classList.remove('d-none');
                if (maxRoundsField && maxRoundsLabel) {
                    maxRoundsLabel.textContent = 'Max Rounds';
                    maxRoundsField.min = '1';
                    maxRoundsField.max = '20';
                    maxRoundsField.value = settings.maxRounds || '10';
                }
            }
        });
    }

    if (algorithmMAB) {
        algorithmMAB.addEventListener('change', function () {
            if (this.checked) {
                if (mabSettingsContainer) mabSettingsContainer.classList.remove('d-none');
                if (dynamicMarginContainer) dynamicMarginContainer.classList.add('d-none');
                if (startTokensField) startTokensField.parentElement.classList.add('d-none');

                if (maxRoundsField) { maxRoundsField.parentElement.classList.add('d-none'); }
                // Don't change maxRounds field properties anymore
                if (xploreCoeffField) {
                    xploreCoeffField.value = settings.mabParams.xploreCoeff || '0.3';
                }
            }
        });
    }

    // Query mode toggle
    const interactiveMode = document.getElementById('interactiveMode');
    const staticMode = document.getElementById('staticMode');
    const staticQueryContainer = document.getElementById('staticQueryContainer');
    if (interactiveMode) {
        interactiveMode.addEventListener('change', function () {
            if (this.checked && staticQueryContainer) {
                staticQueryContainer.classList.add('d-none');
            }
        });
    }
    if (staticMode) {
        staticMode.addEventListener('change', function () {
            if (this.checked && staticQueryContainer) {
                staticQueryContainer.classList.remove('d-none');
            }
        });
    }

    // Initialize token slider if exists
    const tokenSlider = document.getElementById('tokenAllocation');
    const tokenValue = document.getElementById('tokenValue');
    if (tokenSlider && tokenValue) {
        tokenSlider.value = settings.tokenAllocation || 1024;
        tokenValue.textContent = tokenSlider.value;
        tokenSlider.addEventListener('input', function () {
            tokenValue.textContent = this.value;
        });
    }

    // Handle alpha and beta weights
    const alphaWeightInput = document.getElementById('alphaWeight');
    const betaWeightInput = document.getElementById('betaWeight');
    if (alphaWeightInput && betaWeightInput) {
        alphaWeightInput.value = settings.weights.alpha || 0.7;
        betaWeightInput.value = settings.weights.beta || 0.3;
        alphaWeightInput.addEventListener('input', function () {
            let alphaValue = parseFloat(this.value);
            alphaValue = Math.max(0, Math.min(1, alphaValue));
            this.value = alphaValue.toFixed(1);
            betaWeightInput.value = (1 - alphaValue).toFixed(1);
        });
        betaWeightInput.addEventListener('input', function () {
            let betaValue = parseFloat(this.value);
            betaValue = Math.max(0, Math.min(1, betaValue));
            this.value = betaValue.toFixed(1);
            alphaWeightInput.value = (1 - betaValue).toFixed(1);
        });
    }

    // Initialize other parameters
    if (document.getElementById('startTokens')) {
        document.getElementById('startTokens').value = settings.startTokens || 64;
    }

    if (document.getElementById('maxRounds')) {
        document.getElementById('maxRounds').value = settings.maxRounds || 10;
    }

    if (document.getElementById('xploreCoeff')) {
        document.getElementById('xploreCoeff').value = settings.mabParams.xploreCoeff || 0.3;
    }

    if (document.getElementById('dynamicMarginCoeff')) {
        document.getElementById('dynamicMarginCoeff').value =
            settings.earlyStoppingParams.dynamicMarginCoeff || 1.0;
    }

    if (document.getElementById('embeddingModel')) {
        const embeddingSelect = document.getElementById('embeddingModel');
        const embeddingModel = settings.otherParams.embeddingModel || 'nomic-embed-text';
        for (let i = 0; i < embeddingSelect.options.length; i++) {
            if (embeddingSelect.options[i].value === embeddingModel) {
                embeddingSelect.selectedIndex = i;
                break;
            }
        }
    }
}
// Call the initialization function when the document is loaded
initAdvancedSettingsModal();
// Replace the saveAdvancedSettings event listener implementation
document.getElementById('saveAdvancedSettings')?.addEventListener('click', function () {
    // Get the selected algorithm type
    const algorithmType = document.querySelector('input[name="algorithmType"]:checked').value;
    // Get active models as array from dynamic checkboxes
    const modelCheckboxes = document.querySelectorAll('.model-checkbox');
    const activeModels = [];
    const modelSettings = {};
    if (modelCheckboxes.length > 0) {
        modelCheckboxes.forEach(checkbox => {
            if (checkbox.checked) {
                const modelId = checkbox.getAttribute('data-model-id');
                if (modelId) {
                    const baseModelName = modelId.split(':')[0];
                    activeModels.push(baseModelName);
                    modelSettings[baseModelName] = true;
                }
            }
        });
    } else {
        // Fallback to legacy checkboxes
        if (document.getElementById('modelLlama') && document.getElementById('modelLlama').checked) {
            activeModels.push("llama3.1");
            modelSettings.llama = true;
        }
        if (document.getElementById('modelMistral') && document.getElementById('modelMistral').checked) {
            activeModels.push("mistral");
            modelSettings.mistral = true;
        }
        if (document.getElementById('modelQwen') && document.getElementById('modelQwen').checked) {
            activeModels.push("qwen2.5");
            modelSettings.qwen = true;
        }
    }
    // Update settings with model selections
    settings.models = modelSettings;
    settings.algorithmType = algorithmType;
    // Get token allocation from UI
    const tokenAllocation = parseInt(document.getElementById('tokenAllocation').value);
    settings.tokenAllocation = tokenAllocation;
    // Different settings for different algorithms
    if (algorithmType === 'stepwise') {
        // Update settings with UI values for stepwise algorithm
        settings.startTokens = parseInt(document.getElementById('tokenAllocation').value);
        settings.maxRounds = 10;
        settings.weights.alpha = parseFloat(document.getElementById('alphaWeight').value);
        settings.weights.beta = parseFloat(document.getElementById('betaWeight').value);
        settings.earlyStoppingParams.dynamicMarginCoeff =
            parseFloat(document.getElementById('dynamicMarginCoeff').value);
        // Update llmMsConfig for Stepwise/OUA algorithm
        llmMsConfig = {
            ALGORITHM_TYPE: 'stepwise',
            MODELS: activeModels,
            EMBEDDING_MODEL: document.getElementById('embeddingModel').value,
            START_TOKENS: settings.startTokens,
            MAX_ROUNDS: settings.maxRounds,
            MAX_TOKENS: tokenAllocation,
            ALPHA: settings.weights.alpha,
            BETA: settings.weights.beta,
            DYNAMIC_MARGIN_COEFF: settings.earlyStoppingParams.dynamicMarginCoeff,
        };
    } else {
        // MAB algorithm configuration
        // When algorithm is MAB, the maxRounds field is repurposed for exploration coefficient
        const explorationCoeff = parseFloat(document.getElementById('maxRounds').value) ||
            parseFloat(document.getElementById('xploreCoeff').value) || 0.3;
        settings.mabParams.xploreCoeff = explorationCoeff;
        llmMsConfig = {
            ALGORITHM_TYPE: 'mab',
            MODELS: activeModels,
            EMBEDDING_MODEL: document.getElementById('embeddingModel').value,
            MAX_TOKENS: tokenAllocation,
            XPLORE_COEFF: explorationCoeff,
            MAX_ROUNDS: 50  // Default value for MAB algorithm
        };
    }
    // Save to session storage
    sessionStorage.setItem('settings', JSON.stringify(settings));
    sessionStorage.setItem('llmMsConfig', JSON.stringify(llmMsConfig));
    // Update the model button text to reflect LLM-MS is active with algorithm type
    const algorithmIndicator = settings.algorithmType === 'stepwise' ? 'Stepwise' : 'MAB';
    document.getElementById('modelbutton').textContent = `LLM-MS-OUA (${algorithmIndicator})`;
    // Close the modal
    const modal = bootstrap.Modal.getInstance(document.getElementById('advancedSettingsModal'));
    if (modal) modal.hide();
    // Show notification
    console.log(`Advanced LLM-MS settings applied successfully\nAlgorithm: ${algorithmIndicator}`);
});
//get the venet listener for the send button

window.addEventListener('resize', () => {
    // get the new dimensions
    windowWidth = window.innerWidth;
    windowHeight = window.innerHeight;
});
// add listener to the window for resizing
window.addEventListener('resize', () => {
    // get the new dimensions
    windowWidth = window.innerWidth;
    windowHeight = window.innerHeight;
});
const sessionList = document.getElementById('session-list'); // The container for session items
const modelCache = {
    data: null,
    timestamp: 0,
    maxAge: 60000 // 1 minute cache
};
async function populateModels() {
    try {
        // Check if we have a valid cache
        const now = Date.now();
        if (modelCache.data && (now - modelCache.timestamp < modelCache.maxAge)) {
            updateModelDropdown(modelCache.data);
            return;
        }
        // Fetch models from the API
        const response = await fetch(`/api/get_models`);
        if (!response.ok) throw new Error('Failed to fetch models');
        const data = await response.json();
        // Cache the result
        modelCache.data = data;
        modelCache.timestamp = now;
        updateModelDropdown(data);
    } catch (error) {
        console.error('Error:', error.message);
        // Handle error case for dropdown using specific element IDs
        const dropdownMenu = document.getElementById('modelmenu');
        dropdownMenu.innerHTML = `<li class="dropdown-item text-danger">Error loading models</li>`;
        const dropdownButton = document.getElementById('modelbutton');
        dropdownButton.textContent = 'Error';
        dropdownButton.setAttribute('aria-label', 'Error loading models');
    }
}
function updateModelDropdown(data) {
    data = {
        models: [
            { id: 'llama3.2:latest', name: 'Llama 3.2', context_length: 4096 },
            { id: 'mistral:latest', name: 'Mistral', context_length: 8192 },
            { id: 'qwen2.5:latest', name: 'Qwen 2.5', context_length: 8192 },

            { id: 'gemma2:latest', name: 'Gemma2', context_length: 8192 },
            { id: 'deepseek-r1:latest', name: 'Deepseek R1', context_length: 8192 }
        ]
    };
    // Reference dropdown elements using specific IDs
    const dropdownButton = document.getElementById('modelbutton');
    const dropdownMenu = document.getElementById('modelmenu');
    // Clear existing items
    dropdownMenu.innerHTML = '';
    if (!data.models || data.models.length === 0) {
        // Handle case when no models are available
        const noModelsItem = document.createElement('li');
        noModelsItem.classList.add('dropdown-item', 'text-muted');
        noModelsItem.textContent = 'No models available';
        noModelsItem.setAttribute('role', 'menuitem');
        dropdownMenu.appendChild(noModelsItem);
        dropdownButton.textContent = 'Select a model';
        return;
    }
    // Use DocumentFragment for batch DOM updates
    const fragment = document.createDocumentFragment();
    // Populate the dropdown with models
    data.models.forEach((model) => {
        const listItem = document.createElement('li');
        const link = document.createElement('a');
        // Set attributes for Bootstrap 5 dropdown
        link.classList.add('dropdown-item');
        link.href = '#';
        link.textContent = model.name;
        link.dataset.value = model.id;
        // Accessibility
        link.setAttribute('role', 'menuitem');
        link.setAttribute('aria-label', `Select model ${model.name}`);
        // Append <a> to <li> and then to the menu
        listItem.appendChild(link);
        fragment.appendChild(listItem);
    });
    // Append all items at once
    dropdownMenu.appendChild(fragment);
    // Add event listeners to dropdown items
    dropdownMenu.addEventListener('click', (event) => {
        if (event.target.classList.contains('dropdown-item')) {
            const selectedModel = event.target.textContent;
            const selectedModelId = event.target.dataset.value;
            // Update the button label
            dropdownButton.textContent = selectedModel;
            dropdownButton.setAttribute('aria-label', `Selected model: ${selectedModel}`);
            localStorage.setItem('selectedModel', selectedModelId);
        }
    });
    // Set default model (e.g., "Llama3.2" or the first in the list)
    let defaultModel = data.models[0];
    for (let i = 0; i < data.models.length; i++) {
        if (/llama/i.test(data.models[i].name)) {
            defaultModel = data.models[i];
            break;
        }
    }
    if (defaultModel) {
        dropdownButton.textContent = defaultModel.name;
        dropdownButton.setAttribute('aria-label', `Selected model: ${defaultModel.name}`);
        localStorage.setItem('selectedModel', defaultModel.id);
    }
}
// Update session list based on available sessions in localStorage, sorted by last updated
function updateSessionList() {
    sessionList.innerHTML = ''; // Clear previous items
    const sessionHistories = getSessionHistories();
    // Convert the sessionHistories object into an array and sort by lastUpdated
    const sortedSessions = Object.entries(sessionHistories).sort((a, b) => {
        return b[1].lastUpdated - a[1].lastUpdated; // Sort descending by lastUpdated
    });

    // Use DocumentFragment for batch DOM operations
    const fragment = document.createDocumentFragment();

    // Create and append session items based on sorted order
    sortedSessions.forEach(([sessionName]) => {
        //wrap it in a card and card-body
        const sessionItem = createSessionItem(sessionName);
        const card = document.createElement('div');
        card.className = 'card bg-transparent border-0';
        const cardBody = document.createElement('div');
        //make it tight
        cardBody.className = 'card-body p-1';
        cardBody.appendChild(sessionItem);
        card.appendChild(cardBody);
        fragment.appendChild(card);
    });

    // Append all elements at once
    sessionList.appendChild(fragment);
}
// Function to retrieve an object mapping session names to chat histories and their timestamps
function getSessionHistories() {
    const sessionHistories = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(CHAT_PREFIX)) {
            const sessionData = JSON.parse(localStorage.getItem(key));
            sessionHistories[key.replace(CHAT_PREFIX, '')] = sessionData;
        }
    }
    return sessionHistories;
}
// Function to create a session item element
function createSessionItem(session) {
    const item = document.createElement('div');
    item.className = 'session-item d-flex align-items-center mb-2';
    // Session title (clickable to load)
    const title = document.createElement('span');
    title.innerText = session;
    title.className = 'session-title me-auto'; // Add class for styling
    title.style.cursor = 'pointer';
    title.onclick = () => loadChatMemory(session);
    // Edit SVG Icon
    // Edit Icon (Font Awesome)
    const editIcon = document.createElement('i');
    editIcon.className = 'fa-solid fa-pencil p-1'; // Font Awesome pencil icon
    editIcon.style.cursor = 'pointer';
    editIcon.onclick = (e) => {
        e.stopPropagation(); // Prevent triggering the session click
        editSessionName(session);
    };
    const deleteIcon = document.createElement('i');
    deleteIcon.className = 'fa-solid fa-trash p-1'; // Font Awesome trash icon
    deleteIcon.style.cursor = 'pointer';
    deleteIcon.onclick = (e) => {
        e.stopPropagation(); // Prevent triggering the session click
        deleteSession(session);
    };
    // Append all elements to the item container
    item.appendChild(title);
    item.appendChild(editIcon);
    item.appendChild(deleteIcon);
    return item;
}
// Function to create a new session if none is selected
function createNewSession() {
    sessionName = generateUniqueSessionName(); // Generate a unique name
    ////console.log("New session created with name:", sessionName); // Debugging
    chatHistory = [];
    chatmodelhistory = [];
    lastSummarizedIndex = 0; // Reset the last summarized index
    saveChatMemory(); // Save the session to localStorage
    updateSessionList(); // Refresh the session list
    loadChatMemory(sessionName); // Load the newly created session
}
// Edit session name and update the timestamp
function editSessionName(session) {
    const newName = prompt("Enter a new name for this session:", session);
    if (newName && newName !== session) {
        const sessionData = JSON.parse(localStorage.getItem(CHAT_PREFIX + session));
        sessionData.lastUpdated = new Date().getTime(); // Update the timestamp
        localStorage.removeItem(CHAT_PREFIX + session);
        localStorage.setItem(CHAT_PREFIX + newName, JSON.stringify(sessionData));
        if (sessionName === session) sessionName = newName;
        updateSessionList();
    }
}
// Function to delete a session
function deleteSession(session) {
    if (confirm(`Are you sure you want to delete the session "${session}"?`)) {
        localStorage.removeItem(CHAT_PREFIX + session);
        if (sessionName === session) {
            sessionName = null;
            chatHistory = [];
            chatmodelhistory = [];
            lastSummarizedIndex = 0; // Reset the last summarized index
            updateChatHistoryDisplay();
        }
        updateSessionList();
    }
}
function saveChatMemory(newHiddenHistory = null) {
    // Retrieve existing session data if it exists
    const existingSessionData = JSON.parse(localStorage.getItem(CHAT_PREFIX + sessionName)) || {};
    // If hiddenHistory is not set in the existing session, use the provided parameter
    const updatedHiddenHistory = newHiddenHistory !== null ? newHiddenHistory : existingSessionData.hiddenHistory || [];
    const sessionData = {
        history: chatHistory,
        hiddenHistory: updatedHiddenHistory, // Preserve existing hiddenHistory if set
        lastSummarizedIndex: lastSummarizedIndex,
        lastUpdated: new Date().getTime(), // Store the current timestamp
        chatmodelhistory: chatmodelhistory // Store the chat model history
    };
    localStorage.setItem(CHAT_PREFIX + sessionName, JSON.stringify(sessionData));
    updateSessionList();
}
// Ensure a unique session name by adding a counter if necessary
function generateUniqueSessionName() {
    let baseName = "New Session";
    let uniqueName = baseName;
    let counter = 1;
    // Keep generating names until we find a unique one
    while (localStorage.getItem(CHAT_PREFIX + uniqueName) !== null) {
        uniqueName = `${baseName} ${counter++}`;
    }
    return uniqueName;
}
// Load chat memory from localStorage
// Load chat memory from localStorage
function loadChatMemory(session) {
    const sessionData = JSON.parse(localStorage.getItem(CHAT_PREFIX + session));
    if (sessionData) {
        chatHistory = sessionData.history || []; // Load regular chat history
        hiddenHistory = sessionData.hiddenHistory || []; // Load assisting hidden history if it exists
        lastSummarizedIndex = sessionData.lastSummarizedIndex || 0;
        sessionName = session;
        chatmodelhistory = sessionData.chatmodelhistory || []; // Load chat model history if it exists
        updateChatHistoryDisplay();
    } else {
        chatHistory = []; // Default to empty if no session data
        hiddenHistory = [];
        lastSummarizedIndex = 0;
        sessionName = null;
        chatmodelhistory = []; // Default to empty if no session data
    }
    // Add the active class to the selected session
    const sessionItems = document.querySelectorAll('.session-item');
    sessionItems.forEach(item => {
        item.classList.remove('active');
        item.parentElement.parentElement.classList.remove('bg-secondary', 'bg-opacity-25');
        item.parentElement.parentElement.classList.add('bg-transparent');
        if (item.querySelector('.session-title').innerText === session) {
            item.parentElement.parentElement.classList.remove('bg-transparent');
            item.parentElement.parentElement.classList.add('bg-secondary', 'bg-opacity-25');
            item.classList.add('active');
        }
    });
    scrollToBottom();
    focusTextbox();
}
async function manageChatHistory() {
    const selectedModel = localStorage.getItem('selectedModel');
    const modelContextLimits = JSON.parse(localStorage.getItem('modelContextLimits') || '{}');
    let maxContextTokens = modelContextLimits[selectedModel] || 6000;  // Default to 6000 if not found
    const sessionData = JSON.parse(localStorage.getItem(CHAT_PREFIX + sessionName)) || {};
    const hiddenHistory = sessionData.hiddenHistory || [];
    const messagesFromLastSummarized = chatHistory.slice(lastSummarizedIndex);
    // Check if hiddenHistory contains a valid message
    const hiddenHistoryMessage = sessionData.hiddenHistory && Object.keys(sessionData.hiddenHistory).length > 0 ? sessionData.hiddenHistory : null;
    const histodata = {
        model: selectedModel,
        messages: hiddenHistoryMessage ? [hiddenHistoryMessage, ...messagesFromLastSummarized] : messagesFromLastSummarized,
        max_tokens: maxContextTokens
    };

    try {
        const response = await fetch('/api/manage_history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(histodata)
        });
        const data = await response.json();
        if (data.messages) {
            lastSummarizedIndex = chatHistory.length;
            const hiddenHistory = data.messages;  // This is the summarized, assisting history
            saveChatMemory(hiddenHistory);
        }
    } catch (error) {
        console.error("Error managing chat history:", error);
    }
}
// Add a model icon cache at the top with other global variables
const modelIconCache = {};
function getModelIcon(modelName) {
    // Short-circuit for null or undefined
    if (!modelName) return "/img/dmsllogobig.png";
    // Fast lowercase conversion and memory-efficient pattern matching
    const name = modelName.toLowerCase();
    // Check cache first (with original lowercase name to avoid regex processing when possible)
    if (modelIconCache[name]) {
        return modelIconCache[name];
    }
    // Define icon lookup patterns - define this outside function for better performance
    // but keeping it here for the function's self-contained design
    const iconPatterns = [
        { pattern: /deepseek/, icon: '/img/deepseek.png' },
        { pattern: /llama/, icon: '/img/llama.png' },
        { pattern: /mistral/, icon: '/img/mistral.jpg' },
        { pattern: /qwen/, icon: '/img/qwen.png' },
        { pattern: /gemma/, icon: '/img/gemma.png' }
    ];
    // Default icon path
    let iconPath = "/img/dmsllogobig.png";
    // Find matching icon using RegExp test (faster than string includes for this purpose)
    for (let i = 0; i < iconPatterns.length; i++) {
        if (iconPatterns[i].pattern.test(name)) {
            iconPath = iconPatterns[i].icon;
            break;
        }
    }
    // Cache result for future lookups
    modelIconCache[name] = iconPath;
    return iconPath;
}
// Helper function to convert strings to PascalCase
function toPascalCase(str) {
    if (!str) return "";
    // Split on spaces, hyphens, or underscores, then uppercase first letter of each segment
    return str
        .split(/[\s_\-]+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join("");
}
function appendLastMessage() {
    // Retrieve the raw model name from localStorage
    const rawModelName = localStorage.getItem('selectedModel') || "Assistant";
    // Convert it to PascalCase
    const selectedModel = toPascalCase(rawModelName);
    const chatContainer = document.getElementById('chat-history');
    const lastMessage = chatHistory[chatHistory.length - 1];
    if (!lastMessage) return; // Safety check
    // Create an outer container that is always left-aligned and takes full width
    const messageDiv = document.createElement('div');
    messageDiv.className = 'w-full';
    // Create a bubble that stacks header and message content vertically
    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = "flex flex-col items-start text-left " + (innerWidth < 380 ? "p-1" : "p-2");
    // Wrap the parsed content in a div with left padding to simulate a tab
    const indentedContent = `<div style="padding-left: 2em;">${marked.parse(lastMessage.content)}</div>`;
    if (lastMessage.role === 'user') {
        bubbleDiv.style.backgroundColor = "rgba(106,66,194,0.02)";
        // For user, include the font icon next to "You"
        const headerHTML = `<div style="display: inline-flex; align-items: center;">
                              <i class="fa-solid fa-user" style="margin-right: 0.5rem;"></i>
                              <strong>You</strong>
                          </div>`;
        bubbleDiv.innerHTML = headerHTML + indentedContent;
    } else {
        bubbleDiv.style.backgroundColor = "transparent";
        // For assistant, include the model icon image
        const modelIconPath = getModelIcon(selectedModel);
        const headerHTML = `<div style="display: inline-flex; align-items: center;">
                              <img src="${modelIconPath}" alt="${selectedModel} icon" style="width:1.5rem; height:1.5rem; margin-right:0.5rem;">
                              <strong>${selectedModel}</strong>
                          </div>`;
        bubbleDiv.innerHTML = headerHTML + indentedContent;
    }
    messageDiv.appendChild(bubbleDiv);
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}
// Optimize updateChatHistoryDisplay by using DocumentFragment
function updateChatHistoryDisplay() {
    // Retrieve the raw model name from localStorage
    const rawModelName = localStorage.getItem('selectedModel') || "Assistant";
    // Convert it to PascalCase
    const selectedModel = toPascalCase(rawModelName);
    const chatContainer = document.getElementById('chat-history');
    chatContainer.innerHTML = ''; // Clear existing messages
    // Use DocumentFragment for batch DOM operations
    const fragment = document.createDocumentFragment();
    chatHistory.forEach(message => {
        // Remove any <think> tags
        if (message.content.includes('<think>')) {
            message.content = message.content.replace(/<think>.*?<\/think>/g, '');
        }
        const whois = chatmodelhistory[chatHistory.indexOf(message)];
        // Create elements
        const messageDiv = document.createElement('div');
        messageDiv.className = 'w-full';
        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = "flex flex-col items-start text-left " + (innerWidth < 380 ? "p-1" : "p-2");
        // Prepare the indented content
        const contentDiv = document.createElement('div');
        contentDiv.style.paddingLeft = '2em';
        contentDiv.innerHTML = marked.parse(message.content);
        // Create header element
        const headerDiv = document.createElement('div');
        headerDiv.style.display = 'inline-flex';
        headerDiv.style.alignItems = 'center';
        if (message.role === 'user') {
            bubbleDiv.style.backgroundColor = "rgba(106,66,194,0.02)";
            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-user';
            icon.style.marginRight = '0.5rem';
            const strong = document.createElement('strong');
            strong.textContent = 'You';
            headerDiv.appendChild(icon);
            headerDiv.appendChild(strong);
        } else {
            bubbleDiv.style.backgroundColor = "transparent";
            const img = document.createElement('img');
            img.src = getModelIcon(whois);
            img.alt = whois + ' icon';
            img.style.width = '1.5rem';
            img.style.height = '1.5rem';
            img.style.marginRight = '0.5rem';
            const strong = document.createElement('strong');
            strong.textContent = whois;
            headerDiv.appendChild(img);
            headerDiv.appendChild(strong);
        }
        // Assemble the message
        bubbleDiv.appendChild(headerDiv);
        bubbleDiv.appendChild(contentDiv);
        messageDiv.appendChild(bubbleDiv);
        fragment.appendChild(messageDiv);
    });
    // Append all elements at once
    chatContainer.appendChild(fragment);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}
// Optimize appendUserMessage with direct DOM creation instead of innerHTML
function appendUserMessage(input) {
    const chatContainer = document.getElementById('chat-history');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'w-full';
    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = "flex flex-col items-start text-left " + (innerWidth < 380 ? "p-1" : "p-2");
    bubbleDiv.style.backgroundColor = "rgba(106,66,194,0.02)";
    // Create header element with user icon
    const headerDiv = document.createElement('div');
    headerDiv.style.display = 'inline-flex';
    headerDiv.style.alignItems = 'center';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-user';
    icon.style.marginRight = '0.5rem';
    const strong = document.createElement('strong');
    strong.textContent = 'You';
    headerDiv.appendChild(icon);
    headerDiv.appendChild(strong);
    // Create content container
    const contentDiv = document.createElement('div');
    contentDiv.style.paddingLeft = '2em';
    contentDiv.innerHTML = marked.parse(input);
    // Assemble the message
    bubbleDiv.appendChild(headerDiv);
    bubbleDiv.appendChild(contentDiv);
    messageDiv.appendChild(bubbleDiv);
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}
// Event listeners
document.getElementById('new-chat').addEventListener('click', createNewSession);
function showErrorModal(errorTitle = 'Unable to connect to Ollama', errorMessage) {
    // Set the error message text
    document.getElementById('error-title').innerText = errorTitle;
    document.getElementById('errorText').innerText = errorMessage;
    // Show the modal using Bootstrap's JavaScript API
    const errorModal = new bootstrap.Modal(document.getElementById('errorModal'));
    errorModal.show();
}
async function assignSessionNameBySystem(messages) {
    try {
        const selectedModel = localStorage.getItem('selectedModel');
        if (!sessionName) {
            console.error("Session name is null.");
            return;
        }
        const data = {
            model: selectedModel,
            max_tokens: 5,
            messages: messages,
        };

        const response = await fetch('/api/update_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            throw new Error(`Failed to generate session name: ${response.statusText}`);
        }
        const summary = (await response.text()).trim();
        if (summary) {
            const rawSessionData = localStorage.getItem(CHAT_PREFIX + sessionName);
            if (!rawSessionData) {
                console.error("No data in localStorage for session:", sessionName);
                return;
            }
            const sessionData = JSON.parse(rawSessionData);
            sessionData.lastUpdated = Date.now();
            localStorage.removeItem(CHAT_PREFIX + sessionName);
            localStorage.setItem(CHAT_PREFIX + summary, JSON.stringify(sessionData));
            sessionName = summary;
            updateSessionList();
            ////console.log("Session name updated to:", sessionName);
            return sessionName;
        }
    } catch (error) {
        console.error("Error assigning session name:", error);
        showErrorModal("Failed to assign session name", error.message);
    }
    return sessionName;
}
// Initialize dropdowns and load sessions
// populateModels();
updateSessionList();
let isScrolling = false;
let userScrolledUp = false;

function scrollToBottom() {
    if (!isScrolling && !userScrolledUp) {
        isScrolling = true;
        window.requestAnimationFrame(() => {
            const chatHistory = document.getElementById('chat-history');
            chatHistory.scrollTop = chatHistory.scrollHeight;
            isScrolling = false;
        });
    }
}

// Detect when user manually scrolls up
document.getElementById('chat-history').addEventListener('scroll', function () {
    const chatHistory = this;
    // Check if user has scrolled up (not at the bottom)
    const isAtBottom = chatHistory.scrollHeight - chatHistory.clientHeight <= chatHistory.scrollTop + 50;

    // If not at the bottom, user has scrolled up
    if (!isAtBottom) {
        userScrolledUp = true;
    } else {
        // Reset when user scrolls back to bottom
        userScrolledUp = false;
    }
}, { passive: true });
// Define userInput (assuming your input element has the id "user-input")
const userInput = document.getElementById('user-input');
function focusTextbox() {
    const userInput = document.getElementById('user-input');
    if (userInput) {
        userInput.focus();
    }
}
// Prevent browser's native Ctrl + F behavior and focus the textbox instead
document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); // Prevent the browser's default find functionality
        focusTextbox();
    }
    // Clear the input when Esc is pressed
    if (event.key === 'Escape') {
        document.getElementById('user-input').value = ' '; // Clear input
        document.getElementById('user-input').value = ''; // Clear input
    }
});
// Keep the textbox focused unless the user intentionally clicks elsewhere
document.addEventListener('click', (event) => {
    if (event.target !== userInput) {
        // Uncomment the line below if you want to always refocus on the textbox
        // focusTextbox();
    }
});
document.addEventListener('DOMContentLoaded', async () => {
    // Preload common model icons in the background
    const commonModels = ["deepseek", "llama3.1", "mistral", "qwen2.5", "gemma"];
    commonModels.forEach(model => {
        const img = new Image();
        img.src = getModelIcon(model);
    });
    // Add passive event listeners for better scroll performance
    document.addEventListener('scroll', () => { }, { passive: true });
    focusTextbox();
});
let selectedFile = null;
// Trigger the hidden file input when the attach icon is clicked
document.getElementById('upload-button').addEventListener('click', () => {
    document.getElementById('file-input').click();
});
// Function to convert file to base64
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]); // Remove the data URL prefix
        reader.onerror = error => reject(error);
    });
}
// Add intersection observer for lazy loading and improved performance
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            // Element is visible, potentially load or render content
            observer.unobserve(entry.target);
        }
    });
}, { threshold: 0.1 });
// Observe session list items when they're created
function observeSessionItems() {
    document.querySelectorAll('.session-item').forEach(item => {
        observer.observe(item);
    });
}
//Add event listener to the clear all chats button
document.getElementById('clear-all-chats').addEventListener('click', async () => {
    if (confirm("Are you sure you want to clear all chats?")) {
        // Remove only chat-related items from localStorage
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (key && key.startsWith(CHAT_PREFIX)) {
                localStorage.removeItem(key);
            }
        }
        sessionName = null;
        chatHistory = [];
        chatmodelhistory = [];
        lastSummarizedIndex = 0; // Reset the last summarized index
        updateSessionList(); // Refresh the session list
        updateChatHistoryDisplay(); // Clear the chat history display
    }
});
// Add file selection event listener
document.getElementById('file-input').addEventListener('change', (event) => {
    const fileInput = event.target;
    if (fileInput.files && fileInput.files.length > 0) {
        selectedFile = fileInput.files[0];
        // Use the existing file-info-container element
        const fileInfoContainer = document.getElementById('file-info-container');
        const fileNameEl = document.getElementById('file-name');
        if (fileInfoContainer && fileNameEl) {
            // Show the file info container and update the filename
            fileInfoContainer.classList.remove('d-none');
            // Create file icon if it doesn't exist
            let fileIcon = fileNameEl.querySelector('i');
            if (!fileIcon) {
                fileIcon = document.createElement('i');
                fileIcon.className = 'fa fa-file me-2';
                fileNameEl.prepend(fileIcon);
            }
            // Add text with the filename
            const fileText = document.createTextNode(selectedFile.name);
            // Clear existing content (except the icon)
            while (fileNameEl.childNodes.length > 1) {
                fileNameEl.removeChild(fileNameEl.lastChild);
            }
            // Add the filename text
            fileNameEl.appendChild(fileText);
            // Add a remove button if it doesn't exist
            let removeButton = fileNameEl.querySelector('.file-remove-btn');
            if (!removeButton) {
                removeButton = document.createElement('button');
                removeButton.className = 'btn btn-sm text-danger file-remove-btn ms-2';
                removeButton.innerHTML = '<i class="fa fa-times"></i>';
                removeButton.onclick = function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    // Clear the file
                    selectedFile = null;
                    document.getElementById('file-input').value = '';
                    fileInfoContainer.classList.add('d-none');
                };
                fileNameEl.appendChild(removeButton);
            }
        }
    }
    focusTextbox(); // Refocus the input box
});
document.addEventListener('DOMContentLoaded', async () => {
    // Preload common model icons in the background
    const commonModels = ["deepseek", "llama3.1", "mistral", "qwen2.5", "gemma"];
    commonModels.forEach(model => {
        const img = new Image();
        img.src = getModelIcon(model);
    });
    // Add passive event listeners for better scroll performance
    document.addEventListener('scroll', () => { }, { passive: true });
    focusTextbox();
});
document.getElementById('user-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (llmMsEnabled) {
            sendMessage();
        } else {
            submitRequest();
        }
    }
});
document.getElementById('send-button').addEventListener('click', () => {
    if (llmMsEnabled) {
        sendMessage();
    } else {
        submitRequest();
    }
});
document.getElementById('user-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault(); // Prevent the default newline behavior
        if (llmMsEnabled) {
            sendMessage();
        } else {
            submitRequest();
        }
    }
});
document.getElementById('send-button').addEventListener('click', () => {
    if (llmMsEnabled) {
        sendMessage();
    } else {
        submitRequest();
    }
});
// --- UI Helpers ---
function updateFileUI(isEnabled) {
    const fileNameEl = document.getElementById('file-name');
    if (fileNameEl && fileNameEl.querySelector('.badge')) {
        const badge = fileNameEl.querySelector('.badge');
        if (isEnabled) {
            badge.classList.add('bg-success', 'text-white');
            badge.classList.remove('bg-light', 'text-dark');
        } else {
            badge.classList.remove('bg-success', 'text-white');
            badge.classList.add('bg-light', 'text-dark');
        }
    }
}
/**
 * Submit a chat request.
 * - Validates selected model and session.
 * - Updates chat history and UI.
 * - If client-side RAG is enabled, checks if a file is selected and ingested;
 *   if not, it processes the file locally.
 * - Retrieves context from the vector store if available.
 * - Otherwise, sends the message (and file data, if any) to the server.
 */
async function submitRequest() {
    console.log("submitRequest: Starting submission process...");
    // Check if a model is selected.
    const rawModel = localStorage.getItem('selectedModel');
    if (!rawModel || rawModel === 'null' || rawModel.trim() === '') {
        showErrorModal('Model is not selected', 'Please select a model');
        return;
    }
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
    // Prepare context for the API call.
    const selectedModel = rawModel;
    const sessionData = JSON.parse(localStorage.getItem(CHAT_PREFIX + sessionName)) || {};
    const hiddenHistory = sessionData.hiddenHistory || [];
    const messagesFromLastSummarized = chatHistory.slice(lastSummarizedIndex);
    const modelContextLimits = JSON.parse(localStorage.getItem('modelContextLimits') || '{}');
    let maxContextTokens = modelContextLimits[selectedModel] || 6000;
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
    // Build the base data structure for sending.
    let data = {
        model: selectedModel,
        messages: hiddenHistoryMessage ? [hiddenHistoryMessage, ...messagesFromLastSummarized] : messagesFromLastSummarized,
        websearch: false,
        clientSideRag: false
    };
    // Build the chat container UI for streaming the response.
    const chatContainer = document.getElementById('chat-history');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'w-full';
    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = "flex flex-col items-start text-left " + (innerWidth < 380 ? "p-1" : "p-2");
    bubbleDiv.style.backgroundColor = "transparent";
    const headerDiv = document.createElement('div');
    headerDiv.style.display = 'inline-flex';
    headerDiv.style.alignItems = 'center';
    const modelIcon = document.createElement('img');
    modelIcon.src = getModelIcon(selectedModel);
    modelIcon.alt = selectedModel + ' icon';
    modelIcon.style.width = '1.5rem';
    modelIcon.style.height = '1.5rem';
    modelIcon.style.marginRight = '0.5rem';
    const modelNameElement = document.createElement('strong');
    modelNameElement.textContent = toPascalCase(selectedModel);
    headerDiv.appendChild(modelIcon);
    headerDiv.appendChild(modelNameElement);
    const contentContainer = document.createElement('div');
    contentContainer.style.paddingLeft = '2em';
    contentContainer.className = 'streaming-content';
    bubbleDiv.appendChild(headerDiv);
    bubbleDiv.appendChild(contentContainer);
    messageDiv.appendChild(bubbleDiv);
    chatContainer.appendChild(messageDiv);

    let responseText = "";
    try {

        // If client-side RAG is not enabled, process on the server.
        if (selectedFile) {
            console.log("submitRequest: Processing file on server via /rag_chain");
            const fileBase64 = await fileToBase64(selectedFile);
            const fileData = {
                model: data.model,
                messages: data.messages || [],
                fileData: fileBase64,
                fileName: selectedFile.name,
                fileType: selectedFile.type,
                fileSize: selectedFile.size,
                clientSideRag: false
            };
            const response = await fetch('/api/rag_chain', {
                method: 'POST',
                body: JSON.stringify(fileData),
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            if (!response.ok) throw new Error(response.statusText);
            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                responseText += chunk;
                contentContainer.innerHTML = marked.parse(responseText);
                scrollToBottom();
            }
        } else {
            console.log("submitRequest: Sending JSON data via /send_message");
            const response = await fetch('/api/send_message', {
                method: 'POST',
                body: JSON.stringify(data),
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            if (!response.ok) throw new Error(response.statusText);
            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                responseText += chunk;
                contentContainer.innerHTML = marked.parse(responseText);
                scrollToBottom();
            }
        }

        // Append the assistant's response to chat history.
        console.log("submitRequest: Appending assistant response to history.");
        const assistantMessage = { role: 'assistant', content: responseText };
        chatHistory.push(assistantMessage);
        chatmodelhistory.push(selectedModel);
        saveChatMemory();
        //reset the file input
        selectedFile = null;
        document.getElementById('file-input').value = '';
        const fileInfoContainer = document.getElementById('file-info-container');
        if (fileInfoContainer) { fileInfoContainer.classList.add('d-none'); }
    } catch (error) {
        console.error("submitRequest: Error during submission:", error);
        contentContainer.innerHTML = `<div class="text-danger">Error: ${error.message}</div>`;
        showErrorModal(error.message);
    } finally {
        // Await any pending history management.
        if (historyPromise) await historyPromise;
        inputEl.value = '';
        if (chatHistory.length >= 1 && sessionName.includes('New Session')) {
            sessionName = await assignSessionNameBySystem(chatHistory);
        }
        if (selectedFile) {
            selectedFile = null;
            document.getElementById('file-input').value = '';
            const fileInfoContainer = document.getElementById('file-info-container');
            if (fileInfoContainer) { fileInfoContainer.classList.add('d-none'); }
        }
        console.log("submitRequest: Submission process complete.");
    }
}
let llmMsEnabled = localStorage.getItem('llmMsEnabled') === 'true';
let llmmstoggle = document.getElementById('llm-ms-toggle');

// Check the toggle based on stored preference
if (llmmstoggle) {
    llmmstoggle.checked = llmMsEnabled;

    // Set initial model menu based on current mode
    if (llmMsEnabled) {
        populateModelMenu();
        selectModel(sessionStorage.getItem('selectedModel') || 'LLM-MS-OUA');
    } else {
        populateModels();
    }

    // Add toggle event listener
    llmmstoggle.addEventListener('click', () => {
        if (llmmstoggle.checked) {
            console.log("LLM-MS is enabled");
            localStorage.setItem('llmMsEnabled', 'true');
            llmMsEnabled = true;

            // Update dropdown to show LLM-MS algorithm options
            populateModelMenu();
            selectModel(sessionStorage.getItem('selectedModel') || 'LLM-MS-OUA');

            // Update model button to show current LLM-MS algorithm
            const algorithmType = llmMsConfig.ALGORITHM_TYPE === 'stepwise' ? 'OUA' : 'MAB';
            modelButton.textContent = `LLM-MS-${algorithmType}`;

        } else {
            console.log("LLM-MS is disabled");
            localStorage.setItem('llmMsEnabled', 'false');
            llmMsEnabled = false;

            // Update dropdown to show regular model options
            populateModels();

            // Reset to default model selection if needed
            const savedModel = localStorage.getItem('selectedModel');
            if (savedModel && (savedModel === 'LLM-MS-OUA' || savedModel === 'LLM-MS-MAB')) {
                localStorage.removeItem('selectedModel');
            }
        }
    });
}

// Update the send button event handlers based on current mode
document.getElementById('user-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (llmMsEnabled) {
            sendMessage();
        } else {
            submitRequest();
        }
    }
});

document.getElementById('send-button').addEventListener('click', () => {
    if (llmMsEnabled) {
        sendMessage();
    } else {
        submitRequest();
    }
});

// Helper function to update metrics display in streaming UI
function updateMetricsDisplay(elements, metrics) {
    if (!elements.metricsContainer || !elements.metricsContent) return;

    // Make metrics container visible
    elements.metricsContainer.classList.remove('d-none');

    let metricsHtml = '<div class="metrics-table">';

    // Helper function to safely format numbers
    const formatNumber = (value) => {
        if (value === undefined || value === null) return 'N/A';
        if (typeof value === 'number') return value.toFixed(2);
        if (typeof value === 'string' && !isNaN(parseFloat(value))) {
            return parseFloat(value).toFixed(2);
        }
        return value.toString();
    };

    // Display token usage if available
    if (metrics.token_usage !== undefined) {
        metricsHtml += `<div class="metrics-row">
            <span>Token Usage:</span>
            <span>${metrics.token_usage}</span>
        </div>`;
    }

    // Display cumulative tokens if available
    if (metrics.cumulative_tokens !== undefined) {
        metricsHtml += `<div class="metrics-row">
            <span>Cumulative Tokens:</span>
            <span>${metrics.cumulative_tokens}</span>
        </div>`;
    }

    // Display current round if available
    if (metrics.current_round !== undefined) {
        metricsHtml += `<div class="metrics-row">
            <span>Round:</span>
            <span>${metrics.current_round} / ${metrics.max_rounds || '?'}</span>
        </div>`;
    }

    // Find highest score for highlighting
    let highestSimScore = -Infinity;
    let highestSimModel = null;
    let highestReward = -Infinity;
    let highestRewardModel = null;

    // Track models with errors
    const modelErrors = metrics.model_errors || {};

    // Process similarity scores from round metrics (usually for stepwise algorithm)
    const processSimilarityScores = () => {
        // Try different places where similarity scores might be stored
        let similarityScores = metrics.similarity_scores || {};

        // Check for scores in round metrics details
        if (metrics.details) {
            for (const [model, detail] of Object.entries(metrics.details)) {
                if (detail.score !== undefined) {
                    similarityScores[model] = detail.score;
                }
            }
        }

        // Check for scores in model_scores
        if (metrics.scores) {
            similarityScores = { ...similarityScores, ...metrics.scores };
        }

        // Check for scores in individual model_scored entries
        if (metrics.model_scored_data) {
            for (const [model, detail] of Object.entries(metrics.model_scored_data)) {
                if (detail.score !== undefined) {
                    similarityScores[model] = detail.score;
                }
            }
        }

        if (Object.keys(similarityScores).length > 0) {
            // Find highest score first
            Object.entries(similarityScores).forEach(([model, score]) => {
                const numScore = parseFloat(score);
                if (!isNaN(numScore) && numScore > highestSimScore) {
                    highestSimScore = numScore;
                    highestSimModel = model;
                }
            });

            metricsHtml += `<div class="metrics-row header">
                <span>Model</span>
                <span>Similarity Score</span>
            </div>`;

            // Output all scores, highlighting the highest
            Object.entries(similarityScores).forEach(([model, score]) => {
                const formattedScore = formatNumber(score);
                const isHighest = model === highestSimModel;
                const hasError = modelErrors[model];

                // Add error indicator if model has errors
                const errorIndicator = hasError ?
                    `<span class="text-danger ms-2" title="${hasError}">⚠️</span>` : '';

                metricsHtml += `<div class="metrics-row ${hasError ? 'text-muted' : ''}">
                    <span>${model}${errorIndicator}</span>
                    <span class="${isHighest && !hasError ? 'highlight-score' : ''}">${formattedScore}</span>
                </div>`;
            });
        }
    };

    // Process query and inter-model similarities if available
    const processDetailedSimilarities = () => {
        // Check if we have q_similarity and inter_similarity data
        let hasSimilarityDetails = false;
        const qSimilarities = {};
        const interSimilarities = {};

        // Check in model_scored_data
        if (metrics.model_scored_data) {
            for (const [model, data] of Object.entries(metrics.model_scored_data)) {
                if (data.q_similarity !== undefined) {
                    qSimilarities[model] = data.q_similarity;
                    hasSimilarityDetails = true;
                }
                if (data.inter_similarity !== undefined) {
                    interSimilarities[model] = data.inter_similarity;
                    hasSimilarityDetails = true;
                }
            }
        }

        // Only show if we have similarity details
        if (hasSimilarityDetails) {
            // Question similarity table
            if (Object.keys(qSimilarities).length > 0) {
                metricsHtml += `<div class="metrics-row header">
                    <span>Model</span>
                    <span>Question Similarity</span>
                </div>`;

                Object.entries(qSimilarities).forEach(([model, value]) => {
                    const formattedValue = formatNumber(value);
                    metricsHtml += `<div class="metrics-row">
                        <span>${model}</span>
                        <span>${formattedValue}</span>
                    </div>`;
                });
            }

            // Inter-model similarity table
            if (Object.keys(interSimilarities).length > 0) {
                metricsHtml += `<div class="metrics-row header">
                    <span>Model</span>
                    <span>Inter-model Similarity</span>
                </div>`;

                Object.entries(interSimilarities).forEach(([model, value]) => {
                    const formattedValue = formatNumber(value);
                    metricsHtml += `<div class="metrics-row">
                        <span>${model}</span>
                        <span>${formattedValue}</span>
                    </div>`;
                });
            }
        }
    };

    // Process rewards (for MAB algorithm)
    const processRewards = () => {
        const rewards = metrics.rewards || {};

        // Check if there are rewards in model_stats
        if (metrics.model_stats) {
            for (const [model, stats] of Object.entries(metrics.model_stats)) {
                if (stats.reward !== undefined) {
                    rewards[model] = stats.reward;
                }
            }
        }

        if (Object.keys(rewards).length > 0) {
            // Find highest reward first
            Object.entries(rewards).forEach(([model, reward]) => {
                const numReward = parseFloat(reward);
                if (!isNaN(numReward) && numReward > highestReward) {
                    highestReward = numReward;
                    highestRewardModel = model;
                }
            });

            metricsHtml += `<div class="metrics-row header">
                <span>Model</span>
                <span>Reward</span>
            </div>`;

            // Output all rewards, highlighting the highest
            Object.entries(rewards).forEach(([model, reward]) => {
                const formattedReward = formatNumber(reward);
                const isHighest = model === highestRewardModel;
                const hasError = modelErrors[model];

                metricsHtml += `<div class="metrics-row ${hasError ? 'text-muted' : ''}">
                    <span>${model}${hasError ? ' ⚠️' : ''}</span>
                    <span class="${isHighest && !hasError ? 'highlight-score' : ''}">${formattedReward}</span>
                </div>`;
            });
        }
    };

    // Process consensus score if available (for OUA algorithm)
    if (metrics.consensus_score !== undefined) {
        metricsHtml += `<div class="metrics-row">
            <span>Consensus Score:</span>
            <span>${formatNumber(metrics.consensus_score)}</span>
        </div>`;
    }

    // Process scores and similarities
    processSimilarityScores();
    processDetailedSimilarities();
    processRewards();

    metricsHtml += '</div>';
    elements.metricsContent.innerHTML = metricsHtml;
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
    let maxContextTokens = modelContextLimits[selectedModel] || 6000;
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
    //const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
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
