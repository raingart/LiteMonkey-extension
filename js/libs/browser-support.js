/**
 * @module BrowserSupport
 * @description Provides a unified cross-browser extension API namespace reference.
 * Normalizes execution context differences between Firefox (promise-based `browser` namespace)
 * and Chromium browsers (using the `chrome` namespace).
 */

/**
 * Safely resolves the root WebExtension API object without throwing ReferenceErrors
 * in non-extension environments (e.g., test runners).
 */
const browserInstance = typeof browser !== 'undefined'
   ? browser
   : (typeof chrome !== 'undefined' ? chrome : undefined);

/**
 * Indicates whether Chrome's Manifest V3 `userScripts` API is supported and available.
 * Used to direct user script execution strategies between native userScripts API and fallback mechanisms.
 * @type {boolean}
 */
export const isChrome = Boolean(browserInstance?.userScripts);

/**
 * The normalized global WebExtension API instance (`browser` or `chrome`).
 * @type {typeof browser | typeof chrome | undefined}
 */
export default browserInstance;
