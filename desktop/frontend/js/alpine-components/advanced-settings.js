// Advanced Settings Modal Script for new_chat.html
// Utilities for safe performance optimization (debounce)
const { debounce } = (() => {
  // Import debounce if available, otherwise provide simple inline version
  if (typeof window.debounceUtil !== 'undefined') {
    return window.debounceUtil;
  }
  // Fallback: simple debounce implementation
  return {
    debounce: function(fn, wait) {
      let timeout;
      return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), wait);
      };
    }
  };
})();

document.addEventListener('DOMContentLoaded', function () {
    // Set default model button text
    const modelButton = document.getElementById('modelbutton');
    if (modelButton) {
        modelButton.textContent = "LLM-MS-OUA";
    }

    // Token allocation slider (with debounce for performance)
    const tokenSlider = document.getElementById('tokenAllocation');
    const tokenValue = document.getElementById('tokenValue');

    if (tokenSlider && tokenValue) {
        const updateTokenValue = debounce(function() {
            tokenValue.textContent = tokenSlider.value;
        }, 100);
        tokenSlider.addEventListener('input', updateTokenValue);
    }

    // MAB exploration coefficient slider (with debounce for performance)
    const xploreCoeffSlider = document.getElementById('xploreCoeff');
    const xploreCoeffValue = document.getElementById('xploreCoeffValue');

    if (xploreCoeffSlider && xploreCoeffValue) {
        const updateXploreValue = debounce(function() {
            xploreCoeffValue.textContent = xploreCoeffSlider.value;
        }, 100);
        xploreCoeffSlider.addEventListener('input', updateXploreValue);
    }

    // Handle alpha and beta weights to ensure they always sum to 1.0
    const alphaWeightInput = document.getElementById('alphaWeight');
    const betaWeightInput = document.getElementById('betaWeight');

    if (alphaWeightInput && betaWeightInput) {
        // Add event listener to alpha weight input
        alphaWeightInput.addEventListener('input', function () {
            let alphaValue = parseFloat(this.value);
            // Ensure alpha is between 0 and 1
            alphaValue = Math.max(0, Math.min(1, alphaValue));
            this.value = alphaValue.toFixed(1);
            // Update beta to be 1 - alpha
            betaWeightInput.value = (1 - alphaValue).toFixed(1);
        });

        // Add event listener to beta weight input
        betaWeightInput.addEventListener('input', function () {
            let betaValue = parseFloat(this.value);
            // Ensure beta is between 0 and 1
            betaValue = Math.max(0, Math.min(1, betaValue));
            this.value = betaValue.toFixed(1);
            // Update alpha to be 1 - beta
            alphaWeightInput.value = (1 - betaValue).toFixed(1);
        });
    }

    // Algorithm type toggle
    const algorithmStepwise = document.getElementById('algorithmStepwise');
    const algorithmMAB = document.getElementById('algorithmMAB');
    const mabSettingsContainer = document.getElementById('mabSettingsContainer');
    const dynamicMarginContainer = document.getElementById('dynamicMarginContainer');

    if (algorithmStepwise && algorithmMAB) {
        algorithmStepwise.addEventListener('change', function () {
            if (this.checked && dynamicMarginContainer && mabSettingsContainer) {
                dynamicMarginContainer.classList.remove('d-none');
                mabSettingsContainer.classList.add('d-none');
            }
        });

        algorithmMAB.addEventListener('change', function () {
            if (this.checked && dynamicMarginContainer && mabSettingsContainer) {
                mabSettingsContainer.classList.remove('d-none');
                dynamicMarginContainer.classList.add('d-none');
            }
        });
    }

    // Query mode toggle
    const interactiveMode = document.getElementById('interactiveMode');
    const staticMode = document.getElementById('staticMode');
    const staticQueryContainer = document.getElementById('staticQueryContainer');
    const preloadedQuery = document.getElementById('preloadedQuery');
    const userInput = document.getElementById('user-input');

    if (preloadedQuery && userInput) {
        // Add event listener to update input box when preloaded query changes
        preloadedQuery.addEventListener('change', function () {
            userInput.value = this.value;
        });
    }

    if (interactiveMode && staticMode && staticQueryContainer && userInput) {
        interactiveMode.addEventListener('change', function () {
            if (this.checked) {
                staticQueryContainer.classList.add('d-none');
                // Clear the user input when switching to interactive mode
                userInput.value = '';
            }
        });

        staticMode.addEventListener('change', function () {
            if (this.checked && preloadedQuery) {
                staticQueryContainer.classList.remove('d-none');
                // Set the user input to the selected preloaded query
                userInput.value = preloadedQuery.value;
            }
        });
    }

    // Save settings
    const saveSettingsButton = document.getElementById('saveAdvancedSettings');
    if (saveSettingsButton) {
        saveSettingsButton.addEventListener('click', function () {
            // Check which algorithm is selected
            const algorithmTypeInput = document.querySelector('input[name="algorithmType"]:checked');
            const algorithmType = algorithmTypeInput ? algorithmTypeInput.value : 'stepwise';

            // Collect settings
            const settings = {
                algorithmType: algorithmType,
                queryMode: document.querySelector('input[name="queryMode"]:checked')?.value || 'interactive',
                preloadedQuery: preloadedQuery?.value || '',
                models: {},
                tokenAllocation: tokenSlider ? parseInt(tokenSlider.value) : 1024,
                weights: {
                    alpha: alphaWeightInput ? parseFloat(alphaWeightInput.value) : 0.7,
                    beta: betaWeightInput ? parseFloat(betaWeightInput.value) : 0.3,
                },
                earlyStoppingParams: {
                    dynamicMarginCoeff: document.getElementById('dynamicMarginCoeff') ? 
                        parseFloat(document.getElementById('dynamicMarginCoeff').value) : 1.0
                },
                mabParams: {
                    xploreCoeff: xploreCoeffSlider ? parseFloat(xploreCoeffSlider.value) : 0.3
                },
                otherParams: {
                    embeddingModel: document.getElementById('embeddingModel')?.value || 'nomic-embed-text'
                },
            };

            console.log('Advanced LLM-MS Settings:', settings);

            // Get active models as array from dynamic checkboxes
            const activeModels = [];
            const modelSettings = {};
            const modelCheckboxes = document.querySelectorAll('.model-checkbox');

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
                if (document.getElementById('modelLlama')?.checked) {
                    activeModels.push("llama3.1");
                    modelSettings.llama = true;
                }
                if (document.getElementById('modelMistral')?.checked) {
                    activeModels.push("mistral");
                    modelSettings.mistral = true;
                }
                if (document.getElementById('modelQwen')?.checked) {
                    activeModels.push("qwen2.5");
                    modelSettings.qwen = true;
                }
            }

            // Update the settings object with the collected model settings
            settings.models = modelSettings;

            // Update session storage with LLM-MS configuration
            sessionStorage.setItem('llmMsConfig', JSON.stringify({
                ALGORITHM_TYPE: settings.algorithmType,
                MODELS: activeModels,
                EMBEDDING_MODEL: settings.otherParams.embeddingModel,
                DYNAMIC_MARGIN_COEFF: settings.earlyStoppingParams.dynamicMarginCoeff,
                MAX_TOKENS: settings.tokenAllocation,
                XPLORE_COEFF: settings.mabParams.xploreCoeff,
                ALPHA: settings.weights.alpha,
                BETA: settings.weights.beta
            }));

            // Store settings object in session storage
            sessionStorage.setItem('settings', JSON.stringify(settings));

            // Close the modal
            const modalElement = document.getElementById('advancedSettingsModal');
            if (modalElement && typeof bootstrap !== 'undefined') {
                const modal = bootstrap.Modal.getInstance(modalElement);
                if (modal) {
                    modal.hide();
                }
            }

            // Update algorithm indicator
            const algorithmIndicator = settings.algorithmType === 'stepwise' ? 'OUA' : 'MAB';

            // Update the model button text to reflect LLM-MS is active with algorithm type
            if (modelButton) {
                modelButton.textContent = `LLM-MS (${algorithmIndicator})`;
            }

            // If static mode is selected, make sure the input box has the preloaded query
            if (settings.queryMode === 'static' && userInput && preloadedQuery) {
                userInput.value = settings.preloadedQuery;
            }
        });
    }

    // Initialize the LLM-MS toggle if the function exists
    if (typeof window.initializeLlmMsToggle === 'function') {
        window.initializeLlmMsToggle();
    }
});
