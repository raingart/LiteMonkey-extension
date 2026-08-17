/**
 * Hostname and @connect origin checks shared by GM_cookie and GM_xmlhttpRequest.
 */

/**
 * True when `hostname` is exactly `domain` or a subdomain of it.
 * Uses a leading-dot boundary so `notgoogle.com` is not treated as `google.com`.
 *
 * @param {string} hostname
 * @param {string} domain
 * @returns {boolean}
 */
export function hostnameEqualsOrIsSubdomain(hostname, domain) {
   if (!hostname || !domain) return false;
   const host = String(hostname).replace(/\.$/, '').toLowerCase();
   const dom = String(domain).replace(/^\./, '').replace(/\.$/, '').toLowerCase();
   if (!host || !dom) return false;
   return host === dom || host.endsWith(`.${dom}`);
}

/**
 * Document URL for the frame that sent the GM message (not the top-level tab).
 *
 * @param {browser.runtime.MessageSender} [sender]
 * @returns {string}
 */
export function getSenderDocumentUrl(sender) {
   return sender?.url || sender?.tab?.url || '';
}

/**
 * @param {string} urlStr
 * @returns {string|null}
 */
export function hostnameFromUrl(urlStr) {
   if (!urlStr) return null;
   try {
      return new URL(urlStr).hostname;
   } catch {
      return null;
   }
}

/**
 * Strips scheme/path/port from a Tampermonkey `@connect` rule to a hostname token.
 *
 * @param {string} rule
 * @returns {string}
 */
export function parseConnectRuleDomain(rule) {
   let ruleDomain = String(rule || '').trim();
   if (ruleDomain.includes('://')) {
      try {
         ruleDomain = new URL(ruleDomain).hostname;
      } catch {
         ruleDomain = ruleDomain.split('://')[1]?.split('/')[0] || ruleDomain;
      }
   }
   return ruleDomain.split(':')[0].split('/')[0].trim();
}

/**
 * Whether a GM_xmlhttpRequest / GM_download target host is allowed.
 * `@connect self` and the implicit same-origin fallback match the **frame** host only
 * (not subdomains, not the top-level tab host).
 *
 * @param {string} targetHost
 * @param {string|null} documentHost Frame hostname
 * @param {string|string[]} connectRules
 * @returns {boolean}
 */
export function isGmConnectAllowed(targetHost, documentHost, connectRules) {
   if (!targetHost) return false;

   const rules = [].concat(connectRules || []);
   const matched = rules.some((rule) => {
      if (rule === '*') return true;
      if (rule === 'self') {
         return Boolean(documentHost) && targetHost === documentHost;
      }

      const ruleDomain = parseConnectRuleDomain(rule);
      if (!ruleDomain) return false;

      if (ruleDomain.startsWith('*.')) {
         const baseDomain = ruleDomain.substring(2);
         return hostnameEqualsOrIsSubdomain(targetHost, baseDomain);
      }

      return hostnameEqualsOrIsSubdomain(targetHost, ruleDomain);
   });

   if (matched) return true;
   return Boolean(documentHost) && targetHost === documentHost;
}

/**
 * Cookie list/delete filters that may be forwarded to `cookies.getAll` / `cookies.remove`.
 * `url` is never taken from the script — callers must pass the frame URL.
 *
 * @param {Record<string, *>} [details]
 * @returns {{ name?: string, domain?: string, path?: string, secure?: boolean, session?: boolean }}
 */
export function pickCookieQueryFilters(details = {}) {
   const query = {};
   if (details.name != null && details.name !== '') query.name = String(details.name);
   if (details.domain) query.domain = String(details.domain).replace(/^\./, '');
   if (details.path) query.path = String(details.path);
   if (typeof details.secure === 'boolean') query.secure = details.secure;
   if (typeof details.session === 'boolean') query.session = details.session;
   return query;
}

/**
 * Host token from a match/include/exclude rule (`*://example.com/*`, `*.example.com`, etc.).
 *
 * @param {string} rule
 * @returns {string|null} Bare hostname, `*` for global rules, or null if unparseable
 */
export function hostnameFromMatchRule(rule) {
   let pattern = String(rule || '').trim();
   if (pattern.startsWith('-')) pattern = pattern.slice(1).trim();
   if (!pattern) return null;
   if (pattern === '<all_urls>' || pattern === '*://*/*' || pattern === '*://*') return '*';

   const afterScheme = pattern.includes('://')
      ? pattern.replace(/^[a-z*]+:\/\//i, '')
      : pattern.replace(/^\/\//, '');
   const hostPart = afterScheme.split('/')[0].split(':')[0].trim();
   if (!hostPart) return null;
   if (hostPart === '*') return '*';
   return hostPart.replace(/^\*\./, '').replace(/^www\./i, '').toLowerCase() || null;
}

/**
 * Whether a popup customUrls exclude line (`-*://host/*`) applies to `pageHostname`.
 * Uses a domain boundary so `-*://notexample.com/*` does not match `example.com`.
 *
 * @param {string} rule
 * @param {string} pageHostname
 * @returns {boolean}
 */
export function excludeRuleAppliesToHostname(rule, pageHostname) {
   if (typeof rule !== 'string' || !rule.trim().startsWith('-') || !pageHostname) return false;
   const ruleHost = hostnameFromMatchRule(rule);
   if (!ruleHost) return false;
   if (ruleHost === '*') return true;
   const pageHost = String(pageHostname).replace(/^www\./i, '').toLowerCase();
   return hostnameEqualsOrIsSubdomain(pageHost, ruleHost);
}

/**
 * Popup "exclude on this site" line. `*.host` so injection matches apex, www, and subdomains
 * the same way {@link excludeRuleAppliesToHostname} does (bare `host` would miss www).
 *
 * @param {string} hostname Tab hostname, `www.` already stripped by the caller
 * @returns {string}
 */
export function formatSiteExcludeRule(hostname) {
   const host = String(hostname || '').replace(/^www\./i, '').toLowerCase().trim();
   if (!host) return '';
   return `-*://*.${host}/*`;
}

/**
 * Upgrade a popup-era site-wide exclude (`-*://example.com/*`) to `-*://*.example.com/*`
 * so www and subdomains match injection. Path-specific and already-wildcard lines are unchanged.
 *
 * @param {string} line
 * @returns {string}
 */
export function upgradeSiteExcludeLine(line) {
   const trimmed = String(line || '').trim();
   if (!trimmed.startsWith('-')) return trimmed;

   const body = trimmed.slice(1).trim();
   if (/^(?:\*:\/\/|https?:\/\/)\*\./i.test(body)) return trimmed;

   const match = body.match(/^(?:\*:\/\/|https?:\/\/)([^/?#*]+)\/\*$/i);
   if (!match) return trimmed;

   return formatSiteExcludeRule(match[1]) || trimmed;
}

/**
 * @param {string|null|undefined} customUrls
 * @returns {string|null|undefined}
 */
export function normalizeCustomUrlsExcludes(customUrls) {
   if (typeof customUrls !== 'string') return customUrls;
   if (!customUrls.trim()) return customUrls;

   const seen = new Set();
   const unique = [];
   for (const raw of customUrls.split('\n')) {
      const line = upgradeSiteExcludeLine(raw);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      unique.push(line);
   }
   return unique.join('\n');
}

