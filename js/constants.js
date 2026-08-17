import browser from './libs/browser-support.js';

/**
 * @module Constants
 * @description Single source of truth for constants and shared utility helpers used
 * across Background Service Worker, Popup, Options, and Installer pages.
 */

export const manifest = browser?.runtime?.getManifest?.() ?? {};

export const DEFAULT_ICON_URL = browser?.runtime?.getURL?.(
   manifest?.icons?.[48] ?? 'icons/48.png'
) ?? 'icons/48.png';

export const BOOTSTRAP_SCRIPT_ID = 'lite-monkey-bootstrap';

/**
 * Centralized maximum permitted script size in bytes (5MB).
 * @type {number}
 */
export const MAX_SCRIPT_SIZE = 5 * 1024 * 1024;

/** Max JSON-encoded size of a single GM storage value. */
export const MAX_STORAGE_VALUE_SIZE_BYTES = 2 * 1024 * 1024;

/** Max GM storage keys per script. */
export const MAX_STORAGE_KEYS_PER_SCRIPT = 500;

/**
 * Centralized set of domain hostnames trusted for userscript installations.
 * @type {ReadonlySet<string>}
 */
export const TRUSTED_SCRIPT_HOSTS = Object.freeze(new Set([
   'greasyfork.org',
   'sleazyfork.org',
   'openuserjs.org',
   'github.com',
   'gist.githubusercontent.com',
   'raw.githubusercontent.com',
   'userstyles.world',
   'www.userscript.zone',
]));

/**
 * Evaluates whether a domain hostname belongs to a trusted script host.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isTrustedScriptHost(hostname) {
   if (!hostname || typeof hostname !== 'string') return false;
   const cleanHost = hostname.toLowerCase();
   return [...TRUSTED_SCRIPT_HOSTS].some(
      (trustedHost) => cleanHost === trustedHost || cleanHost.endsWith(`.${trustedHost}`)
   );
}

/**
 * Centralized default global extension preferences.
 * Single source of truth across lifecycle, badge manager, update scheduler, and options settings.
 * @type {Readonly<Record<string, any>>}
 */
export const DEFAULT_SETTINGS = Object.freeze({
   autoUpdateIntervalDays: 7,
   showBadgeCount: true,
   badgeColor: '#0d47a1',
   muteAllLogs: false,
   editorMode: 'codemirror',
   theme: 'auto',
   logLevel: 1, // Log levels: { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 }
});

/**
 * List of URL prefixes/schemes representing privileged or internal browser pages.
 * @type {readonly string[]}
 */
export const RESTRICTED_URL_PREFIXES = Object.freeze([
   'chrome://',
   'edge://',
   'about:',
   'opera://',
   'brave://',
   'vivaldi://',
   'view-source:',
   'chrome-extension://',
   'chrome-search://',
   'chrome-untrusted://',
]);

/**
 * Helper function to determine if a URL belongs to an internal or restricted browser page.
 * @param {string} [url] - Target URL string to evaluate.
 * @returns {boolean} True if the URL is internal/privileged and cannot be scripted.
 */
export function isRestrictedUrl(url) {
   // Do not treat undefined/missing tab URLs as restricted browser pages
   if (!url || typeof url !== 'string') return false;
   return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Centralized helper to safely coerce string or numeric IDs into numeric primary key integers.
 * @param {number|string} id
 * @returns {number|string}
 */
export function toNumericId(id) {
   if (typeof id === 'string' && /^\d+$/.test(id.trim())) {
      return Number(id);
   }
   return id;
}

/**
 * Media types accepted for userscript / @require / update downloads.
 * Exact match on the type/subtype (charset ignored). Do not use a `text/` prefix —
 * that would accept `text/html`.
 * @type {readonly string[]}
 */
export const ALLOWED_SCRIPT_MEDIA_TYPES = Object.freeze([
   'text/javascript',
   'text/ecmascript',
   'application/javascript',
   'application/x-javascript',
   'text/plain',
]);

/**
 * @param {string} [contentType]
 * @returns {string} Lowercased type/subtype without parameters.
 */
export function parseMediaType(contentType) {
   return String(contentType || '').split(';')[0].trim().toLowerCase();
}

/**
 * @param {string} [contentType]
 * @returns {boolean}
 */
export function isAllowedScriptContentType(contentType) {
   return ALLOWED_SCRIPT_MEDIA_TYPES.includes(parseMediaType(contentType));
}

/**
 * @param {string} [contentType]
 * @param {string[]} [allowedTypes=[]] Prefixes (ending `/`) or exact media types.
 * @returns {boolean}
 */
export function contentTypeMatchesAllowed(contentType, allowedTypes = []) {
   if (!allowedTypes.length) return true;
   const mediaType = parseMediaType(contentType);
   if (!mediaType) return false;
   return allowedTypes.some((type) => {
      const allowed = String(type).toLowerCase();
      return allowed.endsWith('/') ? mediaType.startsWith(allowed) : mediaType === allowed;
   });
}
