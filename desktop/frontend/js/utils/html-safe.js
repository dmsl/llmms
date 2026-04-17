/**
 * HTML Safety Utilities - Safe HTML handling with optional DOMPurify integration
 * 
 * Provides safe wrappers for innerHTML and text content operations.
 * If DOMPurify is available (window.DOMPurify), uses it for sanitization.
 * Otherwise, falls back to safe textContent insertion.
 * 
 * Usage:
 *   safeInnerHTML(element, '<strong>Bold text</strong>');
 *   safeText(element, userInput); // Always safe, uses textContent
 */

/**
 * Check if DOMPurify is available
 */
function hasDOMPurify() {
    return typeof window !== 'undefined' && window.DOMPurify;
}

/**
 * Sanitize HTML string using DOMPurify if available
 * @param {string} html - HTML string to sanitize
 * @returns {string} - Sanitized HTML or original if DOMPurify unavailable
 */
export function sanitizeHTML(html) {
    if (typeof html !== 'string') {
        console.warn('[sanitizeHTML] Input must be a string');
        return '';
    }

    if (hasDOMPurify()) {
        return window.DOMPurify.sanitize(html);
    } else {
        console.warn('[sanitizeHTML] DOMPurify not loaded; consider adding it for security');
        // Fallback: escape HTML entities
        const div = document.createElement('div');
        div.textContent = html;
        return div.innerHTML;
    }
}

/**
 * Safely set innerHTML on an element (sanitized)
 * @param {Element} element - Target element
 * @param {string} html - HTML content
 * @returns {boolean} - True if successful
 */
export function safeInnerHTML(element, html) {
    if (!(element instanceof Element)) {
        console.warn('[safeInnerHTML] First argument must be a DOM element');
        return false;
    }

    if (typeof html !== 'string') {
        console.warn('[safeInnerHTML] Second argument must be a string');
        return false;
    }

    try {
        element.innerHTML = sanitizeHTML(html);
        return true;
    } catch (error) {
        console.error('[safeInnerHTML] Error setting innerHTML:', error);
        return false;
    }
}

/**
 * Safely set text content on an element (always safe)
 * @param {Element} element - Target element
 * @param {string} text - Text content
 * @returns {boolean} - True if successful
 */
export function safeText(element, text) {
    if (!(element instanceof Element)) {
        console.warn('[safeText] First argument must be a DOM element');
        return false;
    }

    try {
        element.textContent = String(text || '');
        return true;
    } catch (error) {
        console.error('[safeText] Error setting textContent:', error);
        return false;
    }
}

/**
 * Create a safe text node
 * @param {string} text - Text content
 * @returns {Text} - Text node
 */
export function createSafeTextNode(text) {
    return document.createTextNode(String(text || ''));
}

/**
 * Append safe HTML to element
 * @param {Element} element - Target element
 * @param {string} html - HTML to append
 * @returns {boolean} - True if successful
 */
export function appendSafeHTML(element, html) {
    if (!(element instanceof Element)) {
        console.warn('[appendSafeHTML] First argument must be a DOM element');
        return false;
    }

    try {
        const temp = document.createElement('div');
        temp.innerHTML = sanitizeHTML(html);
        while (temp.firstChild) {
            element.appendChild(temp.firstChild);
        }
        return true;
    } catch (error) {
        console.error('[appendSafeHTML] Error appending HTML:', error);
        return false;
    }
}

/**
 * Check if HTML string contains potentially dangerous content
 * @param {string} html - HTML string to check
 * @returns {boolean} - True if potentially dangerous patterns detected
 */
export function isSuspiciousHTML(html) {
    if (typeof html !== 'string') return false;

    const suspiciousPatterns = [
        /javascript:/i,
        /on\w+\s*=/i, // Event handlers like onclick=
        /<script[^>]*>/i,
        /<iframe[^>]*>/i,
        /<object[^>]*>/i,
        /<embed[^>]*>/i,
    ];

    return suspiciousPatterns.some(pattern => pattern.test(html));
}
