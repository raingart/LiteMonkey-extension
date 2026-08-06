/**
 * Safely escapes a string for insertion into HTML text content.
 * @param {any} str The input to escape.
 * @returns {string}
 */
export function escapeHTML(str) {
   if (str == null) return '';
   const safeStr = Array.isArray(str) ? str.join(', ') : String(str);
   return safeStr
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
}

/**
 * Sanitizes URLs to prevent 'javascript:' extension-level XSS privilege escalation
 * @param {string} url
 * @returns {string}
 */
export function sanitizeSafeUrl(url) {
   if (!url || typeof url !== 'string') return '#';
   const trimmed = url.trim().toLowerCase();
   if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return escapeHTML(url.trim());
   }
   return '#'; // Fallback to safe hash if protocol is dangerous
}
