/**
 * Debounce - Utility for debouncing frequent function calls
 * 
 * Delays execution until the function hasn't been called for a specified duration.
 * Useful for slider inputs, scroll events, and other high-frequency handlers.
 * 
 * Usage:
 *   const debouncedSave = debounce(() => { saveToBackend(); }, 500);
 *   slider.addEventListener('input', debouncedSave);
 *   // Will only call saveToBackend() once, 500ms after last slider movement
 */

export function debounce(fn, wait, options = {}) {
    if (typeof fn !== 'function') {
        console.warn('[debounce] First argument must be a function');
        return fn;
    }

    if (typeof wait !== 'number' || wait < 0) {
        console.warn('[debounce] Second argument must be a non-negative number');
        wait = 0;
    }

    let timeout = null;
    let lastResult;

    const debounced = function(...args) {
        const context = this;

        // Clear previous timeout
        if (timeout !== null) {
            clearTimeout(timeout);
        }

        // Schedule new execution
        timeout = setTimeout(() => {
            timeout = null;
            lastResult = fn.apply(context, args);
        }, wait);

        return lastResult;
    };

    /**
     * Cancel pending execution
     */
    debounced.cancel = function() {
        if (timeout !== null) {
            clearTimeout(timeout);
            timeout = null;
        }
    };

    /**
     * Execute immediately if pending
     */
    debounced.flush = function() {
        if (timeout !== null) {
            clearTimeout(timeout);
            timeout = null;
            lastResult = fn.apply(this, arguments);
        }
        return lastResult;
    };

    /**
     * Check if there's a pending execution
     */
    debounced.pending = function() {
        return timeout !== null;
    };

    return debounced;
}

/**
 * Throttle - Utility for throttling frequent function calls
 * 
 * Ensures function is called at most once per specified interval.
 * Useful for scroll events, window resize, and other continuous handlers.
 * 
 * Usage:
 *   const throttledScroll = throttle(() => { updateLayout(); }, 100);
 *   window.addEventListener('scroll', throttledScroll);
 *   // Will call updateLayout() at most once per 100ms
 */

export function throttle(fn, wait, options = {}) {
    if (typeof fn !== 'function') {
        console.warn('[throttle] First argument must be a function');
        return fn;
    }

    if (typeof wait !== 'number' || wait < 0) {
        console.warn('[throttle] Second argument must be a non-negative number');
        wait = 0;
    }

    let timeout = null;
    let previous = 0;
    let lastResult;
    const { leading = true, trailing = true } = options;

    const throttled = function(...args) {
        const context = this;
        const now = Date.now();

        if (!previous && !leading) previous = now;

        const remaining = wait - (now - previous);

        if (remaining <= 0 || remaining > wait) {
            if (timeout !== null) {
                clearTimeout(timeout);
                timeout = null;
            }
            previous = now;
            lastResult = fn.apply(context, args);
        } else if (!timeout && trailing) {
            timeout = setTimeout(() => {
                previous = leading ? Date.now() : 0;
                timeout = null;
                lastResult = fn.apply(context, args);
            }, remaining);
        }

        return lastResult;
    };

    /**
     * Cancel pending execution
     */
    throttled.cancel = function() {
        if (timeout !== null) {
            clearTimeout(timeout);
            timeout = null;
        }
        previous = 0;
    };

    return throttled;
}
