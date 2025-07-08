const CHAT_PREFIX = 'chat_'; // Prefix for identifying chat sessions in localStorage
// Define the base URL for the API by decoding a Base64 string

let llmMsEnabled = false;
let chatHistory = [];
let selectedModel = localStorage.getItem('selectedModel') || 'null';
let sessionName = null;
let lastSummarizedIndex = 0; // Initialize the last summarized index
let chatmodelhistory = []; //who is the user and who is the assistant
// get dimensions of the window
let windowWidth = window.innerWidth;
let windowHeight = window.innerHeight;
// add listener to the window for resizing
window.addEventListener('resize', () => {
    // get the new dimensions
    windowWidth = window.innerWidth;
    windowHeight = window.innerHeight;
});
function getPlatformType() {
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    if (/android/i.test(userAgent)) {
        return "Android";
    }
    if (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) {
        return "iOS";
    }
    if (/windows phone/i.test(userAgent)) {
        return "Windows Phone";
    }
    if (/Macintosh|MacIntel|MacPPC|Mac68K/.test(userAgent)) {
        return "Mac";
    }
    if (/Win32|Win64|Windows/.test(userAgent)) {
        return "Windows";
    }
    if (/Linux/.test(userAgent)) {
        return "Linux";
    }
    return "Unknown";
}
// Save the platform type to a variable
const platformType = getPlatformType();
// console.log("Platform type:", platformType);
const sessionList = document.getElementById('session-list'); // The container for session items
// Web Search Toggle State
let isWebSearchEnabled = false;
function handleWebSearchToggle(event) {
    // Use the event target or default to the button element
    // const button = event?.currentTarget || document.getElementById("websearch-button");
    // Toggle the web search state
    isWebSearchEnabled = !isWebSearchEnabled;
    // Add or remove the 'active' class for visual feedback
    button.classList.toggle("active");
    // Update the tooltip for user feedback
    if (isWebSearchEnabled) {
        //give an alert as it is in beta development
        button.setAttribute("title", "Web Search Enabled");
    } else {
        button.setAttribute("title", "Web Search Disabled");
    }
}

function triggerWebSearchToggle() {
    // const button = document.getElementById("websearch-button");
    // Simulate the click event manually
    handleWebSearchToggle({ currentTarget: button });
}
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
// Separate function for updating the dropdown (called from populateModels)
function updateModelDropdown(data) {
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
    let maxContextTokens = modelContextLimits[selectedModel] || 2048;  // Default to 2048 if not found
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
    //csrfToken = document.querySelector('meta[name="csrf-token"]').content;
    try {
        const response = await fetch(`/api/manage_history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', },
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
                              <img src="${modelIconPath}" alt="${selectedModel} icon" style="width:1.5rem; height:1.5rem; margin-right: 0.5rem;">
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
        //csrfToken = document.querySelector('meta[name="csrf-token"]').content;
        const response = await fetch(`/api/update_session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', },
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
populateModels();
updateSessionList();
let isScrolling = false;
function scrollToBottom() {
    if (!isScrolling) {
        isScrolling = true;
        window.requestAnimationFrame(() => {
            const chatHistory = document.getElementById('chat-history');
            chatHistory.scrollTop = chatHistory.scrollHeight;
            isScrolling = false;
        });
    }
}
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



let isClientSideRagEnabled = false; // Default to false until we check the toggle

// Function to handle client-side RAG toggle
function handleClientSideRagToggle(event) {
    // Toggle the client-side RAG state
    isClientSideRagEnabled = !isClientSideRagEnabled;

    // Get the button element
    const button = event?.currentTarget || document.getElementById("clientsiderag-button");

    // Add or remove the 'active' class for visual feedback
    button.classList.toggle("active");

    // Update the tooltip for user feedback
    if (isClientSideRagEnabled) {
        button.setAttribute("title", "Client-side RAG Enabled");
    } else {
        button.setAttribute("title", "Client-side RAG Disabled");
    }

    // Save the state to localStorage
    localStorage.setItem('clientSideRagEnabled', isClientSideRagEnabled);
}

// Function to manually trigger the toggle
function triggerClientSideRagToggle() {
    const button = document.getElementById("clientsiderag-button");
    // Simulate the click event manually
    handleClientSideRagToggle({ currentTarget: button });
}



// Load the client-side RAG state from localStorage when the page loads
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

    // Load client-side RAG setting from localStorage
    const savedClientSideRagState = localStorage.getItem('clientSideRagEnabled');
    if (savedClientSideRagState === 'true') {
        isClientSideRagEnabled = true;
        // Update UI button state if available
        const clientSideRagButton = document.getElementById('clientsiderag-button');
        if (clientSideRagButton) {
            clientSideRagButton.classList.add('active');
            clientSideRagButton.setAttribute('title', 'Client-side RAG Enabled');
        }
    }

    // Add event listener for the client-side RAG toggle button
    const clientSideRagButton = document.getElementById('clientsiderag-button');
    if (clientSideRagButton) {
        clientSideRagButton.addEventListener('click', handleClientSideRagToggle);
    }
});



document.getElementById('user-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        
        e.preventDefault();
           if (llmMsEnabled) {console.log('Skipping single model appraoch');
    return;} // Exit early if LLM-MS is not enabled
        submitRequest();
    }
});
document.getElementById('send-button').addEventListener('click', () => {
        // Check the current page path
    if (llmMsEnabled) {console.log('Skipping single model appraoch');
    return;} // Exit early if LLM-MS is not enabled
    submitRequest();
});






document.getElementById('user-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault(); // Prevent the default newline behavior
           if (llmMsEnabled) {console.log('Skipping single model appraoch');
    return;} // Exit early if LLM-MS is not enabled
        submitRequest();    // Trigger your send action
    }
});

document.getElementById('send-button').addEventListener('click', () => {
   if (llmMsEnabled) {console.log('Skipping single model appraoch');
    return;} // Exit early if LLM-MS is not enabled
    submitRequest();
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
       if (llmMsEnabled) {console.log('Skipping single model appraoch');
    return;} // Exit early if LLM-MS is not enabled
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

    // Build the base data structure for sending.
    let data = {
        model: selectedModel,
        messages: hiddenHistoryMessage ? [hiddenHistoryMessage, ...messagesFromLastSummarized] : messagesFromLastSummarized,
        websearch: isWebSearchEnabled,
        clientSideRag: isClientSideRagEnabled
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

    //const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
    let responseText = "";

    try {
        // If client-side RAG is enabled, process locally.
        if (isClientSideRagEnabled && selectedFile) {
            console.log("submitRequest: Client-side RAG enabled");
            console.log("submitRequest: Selected file:", selectedFile);
            console.log("submitRequest: Selected model:", selectedModel);
            console.log("submitRequest: Input text:", input);
            console.log("submitRequest: BrowserRetriever instance:", browserRetriever);

            // If a file is selected and not yet ingested, ingest it.
            if (selectedFile && browserRetriever && !(await browserRetriever.hasDocuments())) {
                console.log("submitRequest: Ingesting file with local RAG...");
                const chatMessages = document.getElementById('chat-messages');
                if (chatMessages) {
                    const processingMsg = document.createElement('div');
                    processingMsg.id = 'rag-processing-indicator';
                    processingMsg.className = 'processing-indicator';
                    processingMsg.innerHTML = `
                        <div class="spinner-border spinner-border-sm text-secondary me-2" role="status">
                            <span class="visually-hidden">Loading...</span>
                        </div>
                        <span>Processing document for context retrieval...</span>
                    `;
                    chatMessages.appendChild(processingMsg);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
                const processResult = await processFileWithRag(selectedFile);
                console.log("submitRequest: File ingestion result:", processResult);
                const indicator = document.getElementById('rag-processing-indicator');
                if (indicator) { indicator.remove(); }
                if (!processResult.success) {
                    console.error("submitRequest: File ingestion failed:", processResult.error);
                    if (originalSubmitRequest) {
                        return originalSubmitRequest(event);
                    }
                    return;
                }
            }

            // If documents have been ingested, retrieve context.
            if (browserRetriever && (await browserRetriever.hasDocuments())) {
                console.log("submitRequest: Retrieving context from local RAG...");
                const context = await getLocalRagContext(input);
                console.log("submitRequest: Retrieved context:", context);


                // Instead of directly appending context to the UI, send it as part of the payload
                // to your local_rag_chain endpoint.
                let localRagPayload = {
                    model: selectedModel,
                    messages: data.messages || [],
                    query: input,
                    localContext: context
                };
                console.log("submitRequest: Sending payload to /local_rag_chain", localRagPayload);
                const localResponse = await fetch(`/api/local_rag_chain`, {
                    method: 'POST',
                    body: JSON.stringify(localRagPayload),
                    headers: {
                        'Content-Type': 'application/json',

                    }
                });
                if (!localResponse.ok) throw new Error(localResponse.statusText);
                const localReader = localResponse.body.getReader();
                const localDecoder = new TextDecoder("utf-8");
                while (true) {
                    const { done, value } = await localReader.read();
                    if (done) break;
                    const chunk = localDecoder.decode(value, { stream: true });
                    responseText += chunk;
                    contentContainer.innerHTML = marked.parse(responseText);
                    scrollToBottom();
                }




            }
        } else {
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
                    clientSideRag: isClientSideRagEnabled
                };
                const response = await fetch(`/api/rag_chain`, {
                    method: 'POST',
                    body: JSON.stringify(fileData),
                    headers: {
                        'Content-Type': 'application/json',

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
                const response = await fetch(`/api/send_message`, {
                    method: 'POST',
                    body: JSON.stringify(data),
                    headers: {
                        'Content-Type': 'application/json',

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
        if (isWebSearchEnabled) { triggerWebSearchToggle(); }
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

/**
 * Process the selected file using BrowserRetriever.
 * - Displays a processing indicator.
 * - Supports cancellation.
 * - Returns the ingestion result (with chunk count).
 * @param {File} file - The file to process.
 * @returns {Promise<Object>} - An object with ingestion success status and details.
 */
async function processFileWithRag(file) {
    console.log("processFileWithRag: Starting ingestion for file:", file.name);
    if (!isClientSideRagEnabled || !browserRetriever || !file) {
        return { success: false, error: "RAG not enabled or no file selected" };
    }
    const fileNameEl = document.getElementById('file-name');
    try {
        // Create an AbortController to allow cancellation.
        ragProcessingController = new AbortController();
        const signal = ragProcessingController.signal;
        console.log("processFileWithRag: AbortController created.");

        // Update UI: Show processing indicator with cancel button.
        if (fileNameEl && fileNameEl.querySelector('.badge')) {
            const badgeEl = fileNameEl.querySelector('.badge');
            badgeEl.innerHTML = `
                <i class="fa-solid fa-file me-2"></i>
                <span>${file.name.length > 15 ? file.name.substring(0, 12) + '...' : file.name}</span>
                <span class="ms-2 text-muted small">
                    <i class="fa-solid fa-spinner fa-spin me-1"></i>Processing...
                </span>
                <button type="button" class="btn btn-sm btn-danger ms-2" id="cancel-processing-btn">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            `;
            document.getElementById('cancel-processing-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (ragProcessingController) {
                    ragProcessingController.abort();
                    ragProcessingController = null;
                    console.log("processFileWithRag: Processing canceled by user.");
                    badgeEl.innerHTML = `
                        <i class="fa-solid fa-file me-2"></i>
                        <span>${file.name.length > 15 ? file.name.substring(0, 12) + '...' : file.name}</span>
                        <span class="ms-2 text-warning small">
                            <i class="fa-solid fa-exclamation-circle me-1"></i>Canceled
                        </span>
                        <button type="button" class="btn-close ms-2" aria-label="Remove file" id="remove-file-btn"></button>
                    `;
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

        // Wrap file ingestion in a cancelable promise.
        const result = await new Promise((resolve, reject) => {
            const processTask = browserRetriever.ingestFile(file);
            signal.addEventListener('abort', () => {
                reject(new DOMException('Processing aborted by user', 'AbortError'));
            });
            processTask.then(resolve).catch(reject);
        });

        // Reset the abort controller after processing completes.
        ragProcessingController = null;
        console.log("processFileWithRag: File ingestion complete.", result);

        // Update UI with success indication.
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
        ragProcessingController = null;
        if (error.name === 'AbortError') {
            console.log("processFileWithRag: File processing was canceled by user.");
            return { success: false, error: "Canceled by user" };
        }
        console.error("processFileWithRag: Error processing file with Browser RAG:", error);
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
}

/**
 * Retrieve context from the BrowserRetriever for a given query.
 * Waits for similar documents to be retrieved and formats them into a JSON array.
 * @param {string} query - The query for which to retrieve context.
 * @returns {Promise<Object>} - An object with the context array under the key "context".
 */
async function getLocalRagContext(query) {
    console.log("getLocalRagContext: Received query:", query);

    // If BrowserRetriever isn't available or client-side RAG is disabled, return an empty context array.
    if (!browserRetriever || !isClientSideRagEnabled) {
        console.log("getLocalRagContext: BrowserRetriever not available or client-side RAG disabled");
        return { context: [] };
    }

    try {
        // Await retrieval of similar documents from the vector store.
        const results = await browserRetriever.retrieveRelevantDocuments(query);
        console.log("getLocalRagContext: Retrieved results:", results);

        let contextArray = [];

        // If we have results, format them into a JSON array.
        if (results && results.length > 0) {
            // Loop through each result and add an object with chunk number and text.
            contextArray = results.map((result, index) => {
                if (!result) {
                    console.warn(`getLocalRagContext: Result at index ${index} is undefined, skipping...`);
                    return null;
                }
                return {
                    chunk: index + 1,
                    text: result.text || ""
                };
            }).filter(Boolean);
            console.log("getLocalRagContext: Formatted context array:", contextArray);
        } else {
            console.log("getLocalRagContext: No results found");
        }

        return { context: contextArray };
    } catch (error) {
        console.error("Error retrieving context from Browser RAG:", error);
        return { context: [] };
    }
}

function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function setVH() {
    let vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
}

if (isIOS()) {
    window.addEventListener('resize', setVH);
    setVH();
}


