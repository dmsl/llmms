/**
 * TimerManager - Utility for managing setTimeout/setInterval with automatic cleanup
 * 
 * Prevents dangling timers by tracking all scheduled timers and enabling
 * bulk cancellation on component unmount.
 * 
 * Usage:
 *   const mgr = new TimerManager();
 *   mgr.schedule(() => { console.log('tick'); }, 5000); // setTimeout
 *   mgr.scheduleInterval(() => { console.log('interval'); }, 1000); // setInterval
 *   // Later, on cleanup:
 *   mgr.clearAll();
 */

export class TimerManager {
    constructor() {
        this.timeoutIds = [];
        this.intervalIds = [];
    }

    /**
     * Schedule a one-time callback (setTimeout wrapper)
     * @param {function} fn - Callback to execute
     * @param {number} delay - Delay in milliseconds
     * @returns {number} - Timeout ID
     */
    schedule(fn, delay) {
        if (typeof fn !== 'function' || typeof delay !== 'number') {
            console.warn('[TimerManager] Invalid schedule args:', { fn, delay });
            return null;
        }

        const id = setTimeout(() => {
            fn();
            // Remove from tracking after execution
            const idx = this.timeoutIds.indexOf(id);
            if (idx > -1) this.timeoutIds.splice(idx, 1);
        }, delay);

        this.timeoutIds.push(id);
        return id;
    }

    /**
     * Schedule a recurring callback (setInterval wrapper)
     * @param {function} fn - Callback to execute
     * @param {number} interval - Interval in milliseconds
     * @returns {number} - Interval ID
     */
    scheduleInterval(fn, interval) {
        if (typeof fn !== 'function' || typeof interval !== 'number') {
            console.warn('[TimerManager] Invalid scheduleInterval args:', { fn, interval });
            return null;
        }

        const id = setInterval(fn, interval);
        this.intervalIds.push(id);
        return id;
    }

    /**
     * Clear a specific timeout
     * @param {number} id - Timeout ID
     */
    clearTimeout(id) {
        clearTimeout(id);
        const idx = this.timeoutIds.indexOf(id);
        if (idx > -1) this.timeoutIds.splice(idx, 1);
    }

    /**
     * Clear a specific interval
     * @param {number} id - Interval ID
     */
    clearInterval(id) {
        clearInterval(id);
        const idx = this.intervalIds.indexOf(id);
        if (idx > -1) this.intervalIds.splice(idx, 1);
    }

    /**
     * Clear all scheduled timers (timeouts and intervals)
     */
    clearAll() {
        // Clear all timeouts
        for (const id of this.timeoutIds) {
            clearTimeout(id);
        }
        this.timeoutIds = [];

        // Clear all intervals
        for (const id of this.intervalIds) {
            clearInterval(id);
        }
        this.intervalIds = [];
    }

    /**
     * Get count of active timers
     */
    count() {
        return this.timeoutIds.length + this.intervalIds.length;
    }
}

// Global registry for easy access by component ID
export const globalTimerRegistry = new Map();

export function getTimerManager(componentId) {
    if (!globalTimerRegistry.has(componentId)) {
        globalTimerRegistry.set(componentId, new TimerManager());
    }
    return globalTimerRegistry.get(componentId);
}

export function cleanupTimers(componentId) {
    const mgr = globalTimerRegistry.get(componentId);
    if (mgr) {
        mgr.clearAll();
        globalTimerRegistry.delete(componentId);
    }
}
