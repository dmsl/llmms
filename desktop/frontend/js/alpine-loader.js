// WARNING: AlpineJS now loaded from CDN in chat.html
// All local imports disabled for Electron compatibility.

// Load Alpine.js locally from node_modules
// This ensures Alpine is available before the component tries to use it
// DISABLED: import Alpine from '../node_modules/alpinejs/dist/module.esm.js';

// Register Alpine globally so x-data attributes can use it
// window.Alpine = Alpine;

// Import the chat app component - this MUST happen before Alpine.start()
// DISABLED: import { default as chatAppComponent } from './alpine-components/chat-app.js';

// Now that the component is loaded, start Alpine
// Alpine.start();

// Alpine is now provided by CDN in chat.html
const Alpine = window.Alpine;

export default Alpine;
