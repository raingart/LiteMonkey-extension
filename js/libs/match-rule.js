/**
 * @module MatchRule
 * @description Converts userscript @match/@include/@exclude rules (wildcards or /regex/ literals)
 * into RegExp objects. Shared by background injection and the editor URL tester.
 */

const _regexCache = new Map();

/**
 * Converts a userscript rule (wildcard string or regex literal) into a compiled RegExp object.
 *
 * @param {string} pattern Pattern string (e.g. "https://*.example.com/*" or "/\\d+/").
 * @param {object} [options] Options for regex compilation.
 * @returns {RegExp|null} Compiled regular expression, or null if invalid.
 */
export function parseRuleToRegex(pattern, options = {}) {
   if (typeof pattern !== 'string' || !pattern.trim()) return null;
   const trimmed = pattern.trim();

   // Skip regex-literal detection for protocol-relative patterns
   if (trimmed.startsWith('//')) {
      return wildcardToRegex(trimmed, options);
   }

   // RegExp literal detection: /pattern/flags
   if (trimmed[0] === '/') {
      const lastSlash = trimmed.lastIndexOf('/');
      if (lastSlash > 0) {
         const body = trimmed.slice(1, lastSlash);
         const flags = trimmed.slice(lastSlash + 1);
         if (!/^[gimsuy]*$/.test(flags)) {
            console.error(`Invalid regex flags in rule: "${pattern}"`);
            return null;
         }
         try {
            return new RegExp(body, flags || (options.caseInsensitive ? 'i' : ''));
         } catch (err) {
            console.error(`Invalid RegExp literal in rule: "${pattern}"`, err);
            return null;
         }
      }
   }

   return wildcardToRegex(trimmed, options);
}

/**
 * Converts a wildcard pattern into a RegExp with host-aware logic emulating Tampermonkey behavior.
 * Caches compiled RegExp instances for performance.
 *
 * @param {string} pattern Wildcard pattern string.
 * @param {object} [options] Conversion options.
 * @param {string[]} [options.defaultSchemes=['http', 'https', 'file', 'ftp']] Permitted scheme defaults.
 * @param {boolean} [options.allowLeadingStarDotToMatchBareDomain=true] Whether `*.domain.com` matches `domain.com`.
 * @param {boolean} [options.caseInsensitive=true] Case sensitivity flag.
 * @returns {RegExp|null} Compiled regular expression or null on error.
 */
export function wildcardToRegex(pattern, options = {}) {
   const {
      defaultSchemes = ['http', 'https', 'file', 'ftp'],
      allowLeadingStarDotToMatchBareDomain = true,
      caseInsensitive = true,
   } = options;

   const cacheKey = `${pattern}|${defaultSchemes.join(',')}|${allowLeadingStarDotToMatchBareDomain}|${caseInsensitive}`;
   if (_regexCache.has(cacheKey)) return _regexCache.get(cacheKey);

   let p = pattern;
   let prefix = '^';

   // Process protocol / scheme
   if (p.startsWith('//')) {
      prefix += '(?:[a-z][a-z0-9+.-]*:)?//';
      p = p.slice(2);
   } else {
      const schemeMatch = p.match(/^([a-z*][a-z0-9+\-*]*):\/\//i);
      if (schemeMatch) {
         const schemeToken = schemeMatch[1];
         if (schemeToken === '*') {
            prefix += `(?:${defaultSchemes.join('|')})://`;
         } else if (schemeToken.endsWith('*')) {
            // example: http*:// => https?://
            const base = schemeToken.replace('*', '');
            prefix += base === 'http' ? 'https?://' : `(?:${base}[a-z]*)://`;
         } else {
            prefix += schemeToken + '://';
         }
         p = p.slice(schemeMatch[0].length);
      } else {
         prefix += '(?:[a-z][a-z0-9+.-]*://)?';
      }
   }

   const slashIndex = p.indexOf('/');
   const hostPart = slashIndex === -1 ? p : p.slice(0, slashIndex);
   const pathPart = slashIndex === -1 ? '' : p.slice(slashIndex);

   // Build host regex pattern
   let hostRegex = '';
   if (hostPart.length === 0) {
      hostRegex = '[^/]+';
   } else {
      let host = hostPart;
      if (allowLeadingStarDotToMatchBareDomain && host.startsWith('*.')) {
         hostRegex += '(?:[^/:]+\\.)?';
         host = host.slice(2);
      }
      hostRegex += host.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/:]*').replace(/\?/g, '[^/:]');
      hostRegex += '(?::\\d+)?';
   }

   // Build path regex pattern (`*` crosses slashes)
   const pathRegex = pathPart.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');

   const endsWithStar = pattern.endsWith('*');
   const finalRegex = `${prefix}${hostRegex}${pathRegex}${endsWithStar ? '' : '$'}`;

   try {
      const re = new RegExp(finalRegex, caseInsensitive ? 'i' : '');
      _regexCache.set(cacheKey, re);
      return re;
   } catch (err) {
      console.error(`Failed to create RegExp from wildcard: "${pattern}"`, err);
      _regexCache.set(cacheKey, null);
      return null;
   }
}

/**
 * Tests a URL against match/include and exclude rule lists using the same engine as injection.
 *
 * @param {string} url
 * @param {string[]} [matches=[]]
 * @param {string[]} [excludes=[]]
 * @returns {{ isMatched: boolean, isExcluded: boolean, passed: boolean }}
 */
export function evaluateUrlRules(url, matches = [], excludes = []) {
   const isMatched = matches.length === 0 || matches.some((p) => parseRuleToRegex(p)?.test(url) === true);
   const isExcluded = excludes.some((p) => parseRuleToRegex(p)?.test(url) === true);
   return { isMatched, isExcluded, passed: isMatched && !isExcluded };
}
