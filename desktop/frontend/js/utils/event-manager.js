/**
 * EventManager - Utility for managing event listeners with automatic cleanup
 * 
 * Prevents memory leaks by tracking listeners per component and enabling
 * bulk removal on component unmount. 
 * 
 * Usage:
 *   const mgr = new EventManager('my-component');
 *   mgr.add(window, 'message', handler);
 *   mgr.add(button, 'click', clickHandler);
 *   // Later, on cleanup:
 *   mgr.removeAll();
 */

export class EventManager {
    constructor(componentId = 'default') {
        this.componentId = componentId;
        this.listeners = [];
    }

    /**
     * Add an event listener and track it for cleanup
     * @param {EventTarget} target - DOM element or window/document
     * @param {string} event - Event name (e.g., 'click', 'message')
     * @param {function} handler - Event handler function
     * @param {object} options - Optional addEventListener options (capture, once, passive)
     */
    add(target, event, handler, options = {}) {
        if (!target || !event || !handler) {
            console.warn('[EventManager] Missing arguments:', { target, event, handler });
            return;
        }

        target.addEventListener(event, handler, options);
        this.listeners.push({ target, event, handler, options });
    }

    /**
     * Remove all tracked listeners for this component
     */
    removeAll() {
        for (const { target, event, handler, options } of this.listeners) {
            try {
                target.removeEventListener(event, handler, options);
            } catch (e) {
                console.warn('[EventManager] Error removing listener:', e);
            }
        }
        this.listeners = [];
    }

    /**
     * Get count of tracked listeners
     */
    count() {
        return this.listeners.length;
    }
}

// Global registry for easy access by component ID
export const globalEventRegistry = new Map();

export function getEventManager(componentId) {
    if (!globalEventRegistry.has(componentId)) {
        globalEventRegistry.set(componentId, new EventManager(componentId));
    }
    return globalEventRegistry.get(componentId);
}

export function cleanupComponent(componentId) {
    const mgr = globalEventRegistry.get(componentId);
    if (mgr) {
        mgr.removeAll();
        globalEventRegistry.delete(componentId);
    }
}
