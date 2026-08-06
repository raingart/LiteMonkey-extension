/**
 * @module MatchPattern
 * @description Represents a Chrome / Greasemonkey match pattern.
 * Parses raw pattern strings, validates host/scheme rules, generates execution RegExps,
 * and converts patterns into Manifest V3 host permission strings.
 */

export class MatchPattern {
   /**
    * The normalized pattern string (e.g. "*://*.example.com/*").
    * @type {string|undefined}
    */
   pattern;

   /**
    * Indicates whether the raw pattern string was successfully parsed into a valid match pattern.
    * @type {boolean}
    */
   isValid = false;

   /** @type {string|undefined} */
   #scheme;

   /** @type {string|undefined} */
   #host;

   /** @type {string|undefined} */
   #path;

   /** @type {string|undefined} */
   #query;

   /** @type {RegExp|null} */
   #regex = null;

   /**
    * Constructs and parses a new MatchPattern instance.
    * Accepts standard Chrome Extension match patterns, Greasemonkey `@match` syntax, and shorthand URLs.
    *
    * @param {string} rawPattern - The raw match pattern or URL string to parse.
    */
   constructor(rawPattern) {
      if (typeof rawPattern !== 'string' || !rawPattern.trim()) {
         this.isValid = false;
         return;
      }

      let p = rawPattern.trim();

      // 1. Normalize Chrome & Greasemonkey pattern shorthands
      if (p === '<all_urls>') p = '*://*/*';
      p = p.replace(/^http\*:\/\//, '*://'); // Handle Greasemonkey "http*://" syntax
      if (!p.includes('://')) p = '*://' + p;  // Default missing scheme to wildcards

      // 2. Ensure default path is present
      const schemeEnd = p.indexOf('://') + 3;
      if (p.indexOf('/', schemeEnd) === -1) {
         p += '/*';
      }

      // 3. Match components against flexible pattern regex
      const flexiblePatternRegex = /^(?<scheme>\*|https?|file|ftp):\/\/(?<host>\*|(?:\*\.)?[^/?]+)(?<pathAndQuery>\/.*)?$/;
      const match = p.match(flexiblePatternRegex);

      if (!match || !match.groups) {
         this.isValid = false;
         return;
      }

      const { scheme, host } = match.groups;
      const pathAndQuery = match.groups.pathAndQuery || '/*';

      // 4. Validate host wildcard placement (Chrome MV3 rules: '*' or '*.domain.com' allowed; middle wildcards invalid)
      if (
         (host.includes('*') && host !== '*' && !host.startsWith('*.')) ||
         (host.startsWith('*.') && host.substring(2).includes('*'))
      ) {
         this.isValid = false;
         return;
      }

      this.#scheme = scheme;
      this.#host = host;

      // 5. Separate path from optional query string
      const queryIndex = pathAndQuery.indexOf('?');
      if (queryIndex !== -1) {
         this.#path = pathAndQuery.substring(0, queryIndex);
         this.#query = pathAndQuery.substring(queryIndex + 1);
      } else {
         this.#path = pathAndQuery;
         this.#query = '';
      }

      this.pattern = p;
      this.isValid = true;
   }

   /**
    * Generates and caches a RegExp that tests whether candidate URLs conform to this match pattern.
    *
    * @returns {RegExp|null} The compiled RegExp instance, or null if the pattern is invalid.
    */
   toRegex() {
      if (!this.isValid) return null;
      if (this.#regex) return this.#regex;

      const escape = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const schemeRegex = this.#scheme === '*' ? 'https?' : this.#scheme;

      let hostRegex;
      if (this.#host === '*') {
         hostRegex = '[^/]+';
      } else if (this.#host.startsWith('*.')) {
         // Matches subdomains as well as the root domain (e.g., "*.example.com" matches "sub.example.com" and "example.com")
         hostRegex = `(?:[^./]+\\.)*${escape(this.#host.substring(2))}`;
      } else {
         hostRegex = escape(this.#host);
      }

      let pathRegex = escape(this.#path).replace(/\\\*/g, '.*');

      // Make the trailing slash optional to correctly match root domains (e.g. https://example.com)
      if (pathRegex.endsWith('\\/.*')) {
         pathRegex = pathRegex.substring(0, pathRegex.length - 4) + '(?:\\/.*)?';
      }

      let finalRegexStr;
      if (this.#query) {
         const queryRegex = escape(this.#query).replace(/\\\*/g, '.*');
         // Allow optional hash fragments before end of string anchor $
         finalRegexStr = `^${schemeRegex}:\\/\\/${hostRegex}(?::\\d+)?${pathRegex}\\?.*${queryRegex}(?:#.*)?$`;
      } else {
         // Allow optional query string and optional hash fragments
         finalRegexStr = `^${schemeRegex}:\\/\\/${hostRegex}(?::\\d+)?${pathRegex}(?:\\?.*?)?(?:#.*)?$`;
      }

      this.#regex = new RegExp(finalRegexStr);
      return this.#regex;
   }

   /**
    * Converts the pattern into Chrome Manifest V3 extension host permission strings.
    * Note: Port numbers are explicitly stripped from host permissions as required by Chrome extension manifests.
    *
    * @returns {Set<string>} A set of standard Chrome host permission strings.
    */
   toHostPermissions() {
      if (!this.isValid) return new Set();
      // Only escalate to absolute global wildcard if the scheme is explicitly '*'
      if (this.pattern === '*://*/*') {
         return new Set(['*://*/*']);
      }
      if (this.#scheme === 'file') return new Set(['file:///*']);

      const permissions = new Set();
      const schemes = this.#scheme === '*' ? ['http', 'https'] : [this.#scheme];
      const hostWithoutPort = this.#host.split(':')[0];

      for (const s of schemes) {
         permissions.add(`${s}://${hostWithoutPort}/*`);
      }

      return permissions;
   }

   /**
    * Tests whether a given URL string matches this pattern.
    *
    * @param {string} url - The candidate URL string to evaluate.
    * @returns {boolean} True if the URL matches the pattern, false otherwise.
    */
   test(url) {
      if (typeof url !== 'string' || !url) return false;
      const regex = this.toRegex();
      return regex ? regex.test(url) : false;
   }
}
