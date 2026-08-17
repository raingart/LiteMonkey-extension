/**
 * @module UserstyleRules
 * @description Derives userscript-style @match/@include patterns from `@-moz-document` blocks.
 * Used when a UserStyle has no @match header (Stylus / userstyles.world exports).
 */

const MOZ_RULE_RE = /(domain|url-prefix|url|regexp)\s*\(\s*(['"]?)(.*?)\2\s*\)/gi;

/**
 * @param {string} [userCode='']
 * @returns {string[]} Match/include patterns suitable for getEffectiveRules / MatchPattern.
 */
export function extractMatchPatternsFromStyle(userCode = '') {
   const patterns = new Set();
   const safeCode = String(userCode || '');
   if (!safeCode.includes('@-moz-document')) return [];

   MOZ_RULE_RE.lastIndex = 0;
   let match;
   while ((match = MOZ_RULE_RE.exec(safeCode)) !== null) {
      const type = match[1].toLowerCase();
      const value = (match[3] || '').trim();
      if (!value) continue;

      if (type === 'domain') {
         patterns.add(`*://${value}/*`);
         patterns.add(`*://*.${value}/*`);
      } else if (type === 'url-prefix') {
         patterns.add(`${value}*`);
      } else if (type === 'url') {
         patterns.add(value);
      } else if (type === 'regexp') {
         patterns.add(`/${value}/`);
      }
   }

   return [...patterns];
}

/**
 * True when a userscript rule is a `/pattern/flags` include (not a match pattern).
 * @param {string} pattern
 * @returns {boolean}
 */
export function isRegexLiteralRule(pattern) {
   if (typeof pattern !== 'string') return false;
   const trimmed = pattern.trim();
   if (!trimmed || trimmed.startsWith('//')) return false;
   if (trimmed[0] !== '/') return false;
   const lastSlash = trimmed.lastIndexOf('/');
   return lastSlash > 0;
}
