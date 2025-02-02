const CHAT_PREFIX = 'chat_'; // Prefix for identifying chat sessions in localStorage
let chatHistory = [];
let selectedModel = localStorage.getItem('selectedModel') || 'null';
let sessionName = null;
let lastSummarizedIndex = 0; // Initialize the last summarized index


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
    const button = event?.currentTarget || document.getElementById("websearch-button");

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

// Add event listener for manual click trigger
document.getElementById("websearch-button").addEventListener("click", handleWebSearchToggle);

// Manually trigger the toggle
function triggerWebSearchToggle() {
    const button = document.getElementById("websearch-button");

    // Simulate the click event manually
    handleWebSearchToggle({ currentTarget: button });
}







// async function populateCloneModelDropdown() {
//     try {
//         const response = await fetch(`/get_models`);
//         if (!response.ok) throw new Error(`Failed to fetch models`);

//         const data = await response.json();
//         const modelDropdown = document.getElementById("modelName");
//         modelDropdown.innerHTML = ""; // Clear existing options

//         data.models.forEach((model) => {
//             const option = document.createElement("option");
//             option.value = model.name;
//             option.textContent = model.name;
//             modelDropdown.appendChild(option);
//         });
//     } catch (error) {
//         console.error("Error populating models:", error.message);
//     }
// }



async function populateModels() {
    try {
        // Fetch models from the API
        const response = await fetch(`/get_models`);
        if (!response.ok) throw new Error('Failed to fetch models');

        const data = await response.json();

        // Reference dropdown elements
        const dropdownButton = document.querySelector('.dropdown-toggle');
        const dropdownMenu = document.querySelector('.dropdown-menu');

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
            dropdownMenu.appendChild(listItem);
        });

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
    } catch (error) {
        console.error('Error:', error.message);

        // Handle error case for dropdown
        const dropdownMenu = document.querySelector('.dropdown-menu');
        dropdownMenu.innerHTML = `<li class="dropdown-item text-danger">Error loading models</li>`;
        const dropdownButton = document.querySelector('.dropdown-toggle');
        dropdownButton.textContent = 'Error';
        dropdownButton.setAttribute('aria-label', 'Error loading models');
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
        sessionList.appendChild(card);



    });
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
    editIcon.className = 'bi bi-pencil me-2'; // Font Awesome pencil icon
    editIcon.style.cursor = 'pointer';
    editIcon.onclick = (e) => {
        e.stopPropagation(); // Prevent triggering the session click
        editSessionName(session);
    };

    const deleteIcon = document.createElement('i');
    deleteIcon.className = 'bi bi-trash'; // Font Awesome trash icon
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
        lastUpdated: new Date().getTime() // Store the current timestamp
    };

    localStorage.setItem(CHAT_PREFIX + sessionName, JSON.stringify(sessionData));
    updateSessionList();
}





// Ensure a unique session name by adding a counter if necessary
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
        updateChatHistoryDisplay();
    } else {
        chatHistory = []; // Default to empty if no session data
        hiddenHistory = [];
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
    csrfToken = document.querySelector('meta[name="csrf-token"]').content;
    try {
        const response = await fetch('/manage_history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
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

// Update chat history display
function updateChatHistoryDisplay() {
    const chatContainer = document.getElementById('chat-history');
    chatContainer.innerHTML = ''; // Clear existing chat

    chatHistory.forEach(message => {

        //remove the content between think tag


        if (message.role === 'user') {
            // Create user message element

            const userMessageDiv = document.createElement('div');
            userMessageDiv.className = 'd-flex justify-content-end mb-3 '; // Align to the right
            const userBubble = document.createElement('div');
            userBubble.className = 'bg-secondary rounded p-3 bg-opacity-10'; // Style the bubble
            userBubble.innerHTML = marked.parse(message.content);

            userMessageDiv.appendChild(userBubble);
            document.getElementById('chat-history').appendChild(userMessageDiv);

        } else {
            // Create a response placeholder with a spinner
            const responseDiv = document.createElement('div');
            responseDiv.className = 'dd-flex justify-content-start mb-3 rounded  '; // Align to the left
            const assistantBubble = document.createElement('div');
            assistantBubble.className = 'bg-primary rounded p-3 bg-opacity-10'; // Style the bubble
            assistantBubble.innerHTML = marked.parse(message.content);

            responseDiv.appendChild(assistantBubble);
            document.getElementById('chat-history').appendChild(responseDiv);
        }
    });
}

// Function to handle user input and call the API
async function submitRequest() {
    //check if there is a selected model

    if (localStorage.getItem('selectedModel') == 'null' || localStorage.getItem('selectedModel') == null || localStorage.getItem('selectedModel') == '') {
        showErrorModal('Model is not selected', 'Please select a model');
        return;
    }
    if (!sessionName) createNewSession(); // Ensure a session is created

    const input = document.getElementById('user-input').value;
    document.getElementById('user-input').value = ''; // Clear input
    //remove the websearch activation

    if (!input.trim()) return;

    const selectedModel = localStorage.getItem('selectedModel');
    ////console.log(selectedModel);
    const userMessage = { role: 'user', content: input };
    chatHistory.push(userMessage);

    // Create user message element
    const userMessageDiv = document.createElement('div');
    userMessageDiv.className = 'd-flex justify-content-end mb-3 '; // Align to the right

    const userBubble = document.createElement('div');
    userBubble.className = 'bg-secondary rounded p-3 bg-opacity-10'; // Style the bubble
    userBubble.textContent = input;
    userMessageDiv.appendChild(userBubble);
    document.getElementById('chat-history').appendChild(userMessageDiv);

    saveChatMemory();


    // Get the context limit for the selected model

    const sessionData = JSON.parse(localStorage.getItem(CHAT_PREFIX + sessionName)) || {};
    const hiddenHistory = sessionData.hiddenHistory || [];
    const messagesFromLastSummarized = chatHistory.slice(lastSummarizedIndex);

    const modelContextLimits = JSON.parse(localStorage.getItem('modelContextLimits') || '{}');
    let maxContextTokens = modelContextLimits[selectedModel] || 2048;  // Default to 2048 if not found


    // Calculate total tokens for both hiddenHistory and unsummarized messages
    const totalTokens = messagesFromLastSummarized.reduce((count, message) => {
        return message && message.content ? count + message.content.split(" ").length : count;
    }, 0) + (Array.isArray(hiddenHistory) ? hiddenHistory.reduce((count, message) => {
        return message && message.content ? count + message.content.split(" ").length : count;
    }, 0) : 0); // Fallback to 0 if hiddenHistory is not an array







    // Check if hiddenHistory contains a valid message
    const hiddenHistoryMessage = sessionData.hiddenHistory && Object.keys(sessionData.hiddenHistory).length > 0 ? sessionData.hiddenHistory : null;

    const data = {
        model: selectedModel,
        messages: hiddenHistoryMessage ? [hiddenHistoryMessage, ...messagesFromLastSummarized] : messagesFromLastSummarized,
        websearch: isWebSearchEnabled
    };

    // Create a response placeholder with a spinner
    const responseDiv = document.createElement('div');
    responseDiv.className = 'd-flex justify-content-start mb-3 rounded '; // Align to the left

    const spinner = document.createElement('div');
    spinner.className = 'spinner-grow spinner-grow-sm '; // Bootstrap spinner
    spinner.setAttribute('role', 'status');
    responseDiv.appendChild(spinner);
    document.getElementById('chat-history').appendChild(responseDiv);




    try {
        const response = await postRequest(data, responseDiv);
        const assistantMessage = { role: 'assistant', content: response };
        chatHistory.push(assistantMessage);


        saveChatMemory();

        // Replace spinner with assistant's message
        responseDiv.innerHTML = ''; // Clear the spinner
        const assistantBubble = document.createElement('div');
        assistantBubble.className = 'bg-primary rounded p-3 bg-opacity-10'; // Style the bubble
        assistantBubble.textContent = response;
        responseDiv.appendChild(assistantBubble);
    } catch (error) {
        showErrorModal(error.message);
    } finally {
        if (totalTokens > maxContextTokens) {
            await manageChatHistory();
        }
        spinner.remove();
    }

    document.getElementById('user-input').value = ''; // Clear input
    // Clear the selected file and UI updates related to the file
    selectedFile = null;
    // document.getElementById('upload-status').innerText = '';
    if (isWebSearchEnabled) { triggerWebSearchToggle(); }
    if (chatHistory.length >= 3 && sessionName.includes('New Session')) {
        //update the session name based on the first few messages
        sessionName = await assignSessionNameBySystem(chatHistory);
    }
}

function appendLastMessage() {
    // 1. Grab the chat container
    const chatContainer = document.getElementById('chat-history');

    // 2. Get the last message from chatHistory
    const lastMessage = chatHistory[chatHistory.length - 1];
    if (!lastMessage) return; // Safety check

    // 3. Create the correct bubble (user or assistant)
    let bubbleDiv, bubbleContent;

    if (lastMessage.role === 'user') {
        bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'd-flex justify-content-end mb-3';

        bubbleContent = document.createElement('div');
        bubbleContent.className = 'bg-secondary rounded p-3 bg-opacity-10';
        bubbleContent.textContent = lastMessage.content; // Or .innerHTML if you parse markdown

    } else {
        bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'dd-flex justify-content-start mb-3 rounded';

        bubbleContent = document.createElement('div');
        bubbleContent.className = 'bg-primary rounded p-3 bg-opacity-10';
        bubbleContent.textContent = lastMessage.content; // Or .innerHTML if you parse markdown
    }

    bubbleDiv.appendChild(bubbleContent);
    chatContainer.appendChild(bubbleDiv);

    // Optionally scroll the container to the bottom
    chatContainer.scrollTop = chatContainer.scrollHeight;
}


// Event listeners

document.getElementById('new-chat').addEventListener('click', createNewSession);

document.getElementById('user-input').addEventListener('keydown', (e) => {
    // Listen for Enter key press to submit the request

    if (e.key === 'Enter') submitRequest();

    // if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitRequest();
});

function showErrorModal(errorTitle = 'Unable to connect to Ollama', errorMessage) {
    // Set the error message text
    document.getElementById('error-title').innerText = errorTitle;
    document.getElementById('errorText').innerText = errorMessage;

    // Show the modal using Bootstrap's JavaScript API
    const errorModal = new bootstrap.Modal(document.getElementById('errorModal'));
    errorModal.show();
}

// Function to send a POST request to the API with streaming response
async function postRequest(data, responseDiv) {
    const csrfToken = document.querySelector('meta[name="csrf-token"]').content; // Get CSRF token

    try {
        const response = await fetch(`/send_message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': csrfToken
            },

            body: JSON.stringify(data)
        });

        // Check if the response is not OK (status 200-299)
        if (!response.ok) {
            throw new Error(`Failed to send message: ${response.statusText}`);
        }

        // Process the streaming response if available
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullResponse = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            fullResponse += chunk;
            responseDiv.innerText = fullResponse;  // Update the displayed response incrementally
            scrollToBottom();
        }

        return fullResponse; // Return the full response to be saved in chatHistory

    } catch (error) {
        showErrorModal(error.message); // Show any errors in the error modal
    }
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
        csrfToken = document.querySelector('meta[name="csrf-token"]').content;
        const response = await fetch('/update_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
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



let selectedFile = null;

// File upload handling
document.getElementById('upload-button').addEventListener('click', () => {
    document.getElementById('file-input').click(); // Trigger file input click
});


document.getElementById('file-input').addEventListener('change', (event) => {
    selectedFile = event.target.files[0];


    const fileBubble = document.getElementById('file-bubble');
    if (selectedFile) {
        fileBubble.textContent = 1; // Display the number of files selected
        fileBubble.classList.remove('d-none'); // Make the bubble visible
    } else {
        fileBubble.classList.add('d-none'); // Hide the bubble if no file selected
    }


});

function scrollToBottom() {
    const chatHistory = document.getElementById('chat-history');
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

// Send button handling
document.getElementById('send-button').addEventListener('click', async () => {
    if (selectedFile) {

        await submitRequestWithFile();
        // Clear the selected file and UI updates related to the file
        selectedFile = null;
        document.getElementById('file-input').value = ''; // Clear the file input
        const fileBubble = document.getElementById('file-bubble');
        if (selectedFile) {
            fileBubble.textContent = 1; // Display the number of files selected
            fileBubble.classList.remove('d-none'); // Make the bubble visible
        } else {
            fileBubble.classList.add('d-none'); // Hide the bubble if no file selected
        }
    } else {
        await submitRequest();
    }
});




async function submitRequestWithFile() {
    if (!selectedFile) {
        await submitRequest(); // Fallback to regular submit if no file is attached
        return;
    }
    //check if there is a selected model
    if (localStorage.getItem('selectedModel') == 'null' || localStorage.getItem('selectedModel') == null || localStorage.getItem('selectedModel') == '') {
        showErrorModal('Model is not selected', 'Please select a model');
        return;
    }
    if (!sessionName) createNewSession(); // Ensure a session is created

    const input = document.getElementById('user-input').value;
    document.getElementById('user-input').value = ''; // Clear input
    //remove the websearch activation


    if (!input.trim()) return;

    const selectedModel = localStorage.getItem('selectedModel');
    ////console.log(selectedModel);
    const userMessage = { role: 'user', content: input };
    chatHistory.push(userMessage);
    appendLastMessage();
    saveChatMemory();


    // Get the context limit for the selected model

    const sessionData = JSON.parse(localStorage.getItem(CHAT_PREFIX + sessionName)) || {};
    const hiddenHistory = sessionData.hiddenHistory || [];
    const messagesFromLastSummarized = chatHistory.slice(lastSummarizedIndex);

    const modelContextLimits = JSON.parse(localStorage.getItem('modelContextLimits') || '{}');
    let maxContextTokens = modelContextLimits[selectedModel] || 2048;  // Default to 2048 if not found


    // Calculate total tokens for both hiddenHistory and unsummarized messages
    const totalTokens = messagesFromLastSummarized.reduce((count, message) => {
        return message && message.content ? count + message.content.split(" ").length : count;
    }, 0) + (Array.isArray(hiddenHistory) ? hiddenHistory.reduce((count, message) => {
        return message && message.content ? count + message.content.split(" ").length : count;
    }, 0) : 0); // Fallback to 0 if hiddenHistory is not an array


    ////console.log(totalTokens);
    ////console.log(maxContextTokens);
    if (totalTokens > maxContextTokens) {
        await manageChatHistory();
    }




    // Check if hiddenHistory contains a valid message
    const hiddenHistoryMessage = sessionData.hiddenHistory && Object.keys(sessionData.hiddenHistory).length > 0 ? sessionData.hiddenHistory : null;

    const data = {
        model: selectedModel,
        messages: hiddenHistoryMessage ? [hiddenHistoryMessage, ...messagesFromLastSummarized] : messagesFromLastSummarized,
        websearch: isWebSearchEnabled
    };

    const responseDiv = document.createElement('div');
    responseDiv.className = 'd-flex justify-content-start mb-3 rounded ';
    const spinner = document.createElement('div');
    spinner.className = 'spinner-border text-light';
    spinner.setAttribute('role', 'status');
    responseDiv.appendChild(spinner);
    document.getElementById('chat-history').appendChild(responseDiv);

    ////console.log(data);


    try {
        const response = await postRequestWithFile(data, selectedFile, responseDiv);
        const assistantMessage = { role: 'assistant', content: response };
        chatHistory.push(assistantMessage);


        appendLastMessage();
        saveChatMemory();
    } catch (error) {
        showErrorModal(error.message);
    } finally {
        spinner.remove();
    }

    document.getElementById('user-input').value = ''; // Clear input
    if (isWebSearchEnabled) { triggerWebSearchToggle(); }
    // Clear the selected file and UI updates related to the file
    selectedFile = null;
    // document.getElementById('upload-status').innerText = '';
    document.getElementById('file-input').value = ''; // Clear the file input
    if (chatHistory.length >= 3 && sessionName.includes('New Session')) {
        //update the session name based on the first few messages
        sessionName = await assignSessionNameBySystem(chatHistory);
    }
}
async function postRequestWithFile(data, selectedFile, responseDiv) {
    const formData = new FormData();
    formData.append('model', data.model);
    formData.append('messages', JSON.stringify(data.messages || []));
    formData.append('file', selectedFile);
    csrf_token = document.querySelector('meta[name="csrf-token"]').content;
    // console.log(formData);

    const response = await fetch('/rag_chain', {
        //add the csrf token to the header
        method: 'POST',
        body: formData,
        headers: {
            'X-CSRFToken': csrf_token
        }

    });

    if (!response.ok) {
        console.error(`Error: ${response.statusText}`);
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullResponse = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullResponse += chunk;
        responseDiv.innerText = fullResponse; // Update UI incrementally
        scrollToBottom();
    }
    ////console.log("Response received:", fullResponse);
    return fullResponse;
}


// // Populate the base model dropdown with available models
// async function populateBaseModelDropdown() {
//     try {
//         const response = await fetch(`/get_models`);
//         if (!response.ok) throw new Error("Failed to fetch models");

//         const data = await response.json();
//         const baseModelSelect = document.getElementById("baseModel");

//         // Reset the dropdown and add a placeholder
//         baseModelSelect.innerHTML = '<option value="" disabled selected>Select a base model</option>';
//         data.models.forEach((model) => {
//             const option = document.createElement("option");
//             option.value = model.name;
//             option.textContent = model.name;
//             baseModelSelect.appendChild(option);
//         });
//     } catch (error) {
//         console.error("Error fetching base models:", error.message);
//         alert("Error fetching base models: " + error.message);
//     }
// }



// async function submitModelClone() {
//     const baseModel = document.getElementById("baseModel").value;
//     const modelName = document.getElementById("modelName").value;
//     const contextLength = document.getElementById("contextLength").value;
//     const template = document.getElementById("template").value;
//     const systemMessage = document.getElementById("systemMessage").value;
//     const fileInput = document.getElementById("fileUpload").files[0];

//     const advancedSettings = {
//         adapter: document.getElementById("adapter").value || undefined,
//         license: document.getElementById("license").value || undefined,
//         parameters: document.getElementById("parameters").value
//             ? JSON.parse(document.getElementById("parameters").value)
//             : undefined,
//         messages: document.getElementById("messages").value
//             ? JSON.parse(document.getElementById("messages").value)
//             : undefined,
//     };

//     const formData = new FormData();
//     formData.append("from", baseModel);
//     formData.append("name", modelName);
//     if (contextLength) formData.append("num_ctx", contextLength);
//     if (template) formData.append("template", template);
//     if (systemMessage) formData.append("system", systemMessage);
//     if (fileInput) formData.append("file", fileInput);

//     // Add advanced settings
//     for (const [key, value] of Object.entries(advancedSettings)) {
//         if (value !== undefined) {
//             formData.append(key, JSON.stringify(value));
//         }
//     }

//     csrfToken = document.querySelector('meta[name="csrf-token"]').content;
//     try {
//         const response = await fetch("/create_model", {
//             method: "POST",
//             body: formData,
//             headers: {
//                 "X-CSRFToken": csrfToken,
//             },

//         });

//         if (!response.ok) throw new Error("Failed to create model");

//         const result = await response.json();
//         alert(result.message || "Model created successfully!");
//         populateModels(); // Refresh the model dropdown

//         const modal = bootstrap.Modal.getInstance(document.getElementById("cloneModelModal"));
//         modal.hide();
//     } catch (error) {
//         console.error("Error creating model:", error.message);
//         alert("Error: " + error.message);
//     }
// }



// Form submission handler
// document.getElementById("cloneModelForm").addEventListener("submit", (e) => {
//     e.preventDefault();
//     submitModelClone();
// });

//document.getElementById("clone-model-btn").addEventListener("click", populateCloneModelDropdown);

// Get the theme toggle button
// const themeToggle = document.getElementById('theme-toggle');

// Check for saved theme in localStorage
// const currentTheme = localStorage.getItem('theme');
// if (currentTheme === 'dark') {
//     document.documentElement.classList.add('dark-theme');
// }

// // Add an event listener for the toggle button
// themeToggle.addEventListener('click', () => {
//     document.documentElement.classList.toggle('dark-theme');

//     // Save the user's preference in localStorage
//     if (document.documentElement.classList.contains('dark-theme')) {
//         localStorage.setItem('theme', 'dark');
//     } else {
//         localStorage.setItem('theme', 'light');
//     }
// });
// document.addEventListener('DOMContentLoaded', () => {
//     const dropdownButton = document.getElementById('model-selector-button');
//     const dropdownMenu = document.getElementById('dropdown-menu');


//     // Toggle dropdown visibility on button click
//     dropdownButton.addEventListener('click', (e) => {
//         e.stopPropagation(); // Prevent the click from propagating
//         dropdownMenu.classList.toggle('hidden');
//         dropdownMenu.classList.toggle('visible');
//         dropdownButton.classList.toggle('open');
//     });

//     // Close the dropdown when clicking outside
//     document.addEventListener('click', () => {
//         dropdownMenu.classList.add('hidden');
//         dropdownMenu.classList.remove('visible');
//         dropdownButton.classList.remove('open');
//     });
// });



const userInput = document.getElementById('user-input');

// Function to focus the textbox
function focusTextbox() {
    userInput.focus();
}

// Add focus to the textbox on page load
focusTextbox();

// Prevent browser's native Ctrl + F behavior and focus the textbox instead
document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key === 'f') {
        event.preventDefault(); // Prevent the browser's default find functionality
        focusTextbox();
    }
});

// Keep the textbox focused unless the user intentionally clicks elsewhere
document.addEventListener('click', (event) => {
    if (event.target !== userInput) {
        // focusTextbox();
    }
    // Clear the input when Esc is pressed
    if (event.key === 'Escape') {
        userInput.value = ''; // Clear the input field
    }
});

// // Handle the case when the textbox loses focus due to tabbing out
// userInput.addEventListener('blur', () => {
//     focusTextbox();
// });




const sidebar = document.getElementById('sidebar');
const toggleButton = document.getElementById('toggle-sidebar');
const content = document.getElementById('leftside');

// Update sidebar layout based on screen size
function updateSidebarLayout() {

    // Desktop layout: Sidebar is fixed
    sidebar.classList.add('fixed-sidebar');
    sidebar.classList.add('bg-opacity-10');
    sidebar.classList.add('bg-secondary');
    sidebar.classList.remove('overlay-sidebar', 'active');

}

// Toggle sidebar visibility in overlay mode
//ensure togglebutton is above the sidebar

let sidebarOpenedRecently = false; // Flag to track recent opening





// Run the update function on load and resize
window.addEventListener('resize', updateSidebarLayout);
window.addEventListener('load', updateSidebarLayout);
updateSidebarLayout(); // Run the function on page load 



const toggleIcon = toggleButton.querySelector('i');
toggleButton.addEventListener('click', () => {

    sidebar.classList.toggle('collapsed');
    sidebar.classList.toggle('expanded');

    content.classList.toggle('expanded');
    content.classList.toggle('collapsed');



});



