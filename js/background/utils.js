import browser from '../libs/browser-support.js';
import { manifest, DEFAULT_ICON_URL, ALLOWED_SCRIPT_MEDIA_TYPES, contentTypeMatchesAllowed } from '../constants.js';
import { MSG } from '../message-types.js';
import { agents } from '../database.js';
import { MatchPattern } from '../libs/match-pattern.js';
import { MetadataParser } from '../libs/meta-parser.js';
import { extractMatchPatternsFromStyle, isRegexLiteralRule } from '../libs/userstyle-rules.js';
import { parseRuleToRegex, wildcardToRegex } from '../libs/match-rule.js';
import { normalizeCustomUrlsExcludes } from '../libs/origin-guard.js';
import { generateGmApiCode } from '../gm-api-provider.js';
import { logger } from '../libs/logger.js';
import { generateLogWrapperCode } from './log-wrapper.js';

const CONTEXT = 'Utils';
const REQUIRE_CACHE_NAME = 'require-cache';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours


// Module-scoped Map for deduplicating in-flight @require network requests
const _inFlightRequires = new Map();

// WeakMap memoizer tied to object reference lifecycle (invalidates automatically on object mutation)
const _effectiveRulesCache = new WeakMap();

/**
 * Mapping of Greasemonkey `@grant` permissions to browser WebExtension permissions.
 * Note: `GM_xmlhttpRequest` permissions are checked via `@connect` host matches rather than browser permissions API.
 */
const GRANT_TO_PERMISSION_MAP = {
   GM_notification: ['notifications'],
   'GM.notification': ['notifications'],
   GM_download: ['downloads'],
   'GM.download': ['downloads'],
   GM_setClipboard: ['clipboardWrite'],
   'GM.setClipboard': ['clipboardWrite'],
   GM_getTab: ['tabs'],
   'GM.getTab': ['tabs'],
   GM_getTabs: ['tabs'],
   'GM.getTabs': ['tabs'],
   GM_closeTab: ['tabs'],
   'GM.closeTab': ['tabs'],
};

/**
 * Ensures the provided value is returned as an array.
 *
 * @param {any} value Value to normalize.
 * @returns {Array} Array representation of value.
 */
const ensureArray = (value) => [].concat(value || []);

/**
 * Converts userscript `@run-at` directives into standard Chrome MV3 scripting `runAt` strings.
 *
 * @param {string} runAtValue Userscript `@run-at` header value.
 * @returns {string} Chrome extension compatible run-at string.
 */
const getScriptRunAt = (runAtValue) => {
   switch (runAtValue?.toLowerCase()) {
      case 'document-start':
         return 'document_start';
      case 'document-idle':
         return 'document_idle';
      case 'document-end':
      default:
         return 'document_end';
   }
};


/**
 * Splits @match/@include rules into MV3 host patterns vs rules that require <all_urls>
 * (regex @include, or anything MatchPattern cannot represent).
 *
 * @param {string[]} matches
 * @returns {{ hostPatterns: string[], needsAllUrls: boolean }}
 */
function classifyMatchRulesForPermissions(matches) {
   const hostPatterns = [];
   let needsAllUrls = false;

   for (const raw of matches) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      if (isRegexLiteralRule(raw)) {
         needsAllUrls = true;
         continue;
      }
      const parsed = new MatchPattern(raw);
      if (parsed.isValid && parsed.pattern) {
         hostPatterns.push(parsed.pattern);
      } else {
         needsAllUrls = true;
      }
   }

   return { hostPatterns, needsAllUrls };
}

/**
 * Resolves the effective match and exclude rules for a script,
 * dynamically prioritizing user customUrls over raw script metadata.
 *
 * @param {object} script Script object containing meta and optional customUrls.
 * @returns {{ matches: string[], excludes: string[] }} Object with match and exclude rules.
 */
function getEffectiveRules(script) {
   if (!script) return { matches: [], excludes: [] };

   // Serve cached rule tuple instantly if object reference has not changed
   if (_effectiveRulesCache.has(script)) {
      return _effectiveRulesCache.get(script);
   }

   const meta = script.meta || {};
   let metaMatches = [...ensureArray(meta.match), ...ensureArray(meta.include)];
   const metaExcludes = ensureArray(meta.exclude);

   // Stylus-style UserCSS often has no @match — derive hosts from @-moz-document
   if (metaMatches.length === 0 && script.userCode) {
      const inferred = extractMatchPatternsFromStyle(script.userCode);
      if (inferred.length) metaMatches = inferred;
   }

   let result;
   if (script.customUrls && typeof script.customUrls === 'string' && script.customUrls.trim()) {
      const lines = normalizeCustomUrlsExcludes(script.customUrls).split('\n').map((s) => s.trim()).filter(Boolean);
      const customMatches = lines.filter((l) => !l.startsWith('-'));
      const customExcludes = lines.filter((l) => l.startsWith('-')).map((l) => l.substring(1));

      // If user provided custom excludes but no custom matches, preserve original meta matches!
      const effectiveMatches = customMatches.length > 0 ? customMatches : metaMatches;
      const effectiveExcludes = [...metaExcludes, ...customExcludes];

      result = { matches: effectiveMatches, excludes: effectiveExcludes };
   } else {
      result = { matches: metaMatches, excludes: metaExcludes };
   }

   _effectiveRulesCache.set(script, result);
   return result;
}

/**
 * Checks if a script requires host or API permissions that have not yet been granted.
 *
 * @param {object} script Full script object with `meta` metadata.
 * @returns {Promise<object|null>} Object detailing missing permissions, or null if all are granted.
 */
async function handlePermissionCheck(script) {
   if (!script?.meta) return null;

   // 1. Get active effective match rules (customUrls takes priority)
   const { matches } = getEffectiveRules(script);
   const { hostPatterns, needsAllUrls } = classifyMatchRulesForPermissions(matches);

   const required = {
      origins: new Set(),
      permissions: new Set(),
   };

   if (needsAllUrls) {
      required.origins.add('<all_urls>');
   } else {
      hostPatterns.forEach((p) => {
         new MatchPattern(p).toHostPermissions().forEach((perm) => required.origins.add(perm));
      });
   }

   ensureArray(script.meta.grant).forEach((grant) => {
      const apiPerms = GRANT_TO_PERMISSION_MAP[grant];
      if (apiPerms) apiPerms.forEach((p) => required.permissions.add(p));
   });

   const needed = { origins: [], permissions: [] };

   // Use Chrome's native pattern matching engine instead of strict string Set.has()
   // This correctly evaluates overlapping wildcards (e.g. <all_urls> covers https://example.com/*)
   for (const origin of required.origins) {
      const isGranted = await browser.permissions.contains({ origins: [origin] });
      if (!isGranted) needed.origins.push(origin);
   }

   for (const perm of required.permissions) {
      const isGranted = await browser.permissions.contains({ permissions: [perm] });
      if (!isGranted) needed.permissions.push(perm);
   }

   if (needed.origins.length === 0 && needed.permissions.length === 0) {
      return null;
   }

   return needed;
}

/**
 * Determines whether a script should execute on a URL by evaluating effective `@match`, `@include`, and `@exclude` rules.
 *
 * @param {object} item Script object containing metadata or customUrls.
 * @param {string} url Target URL to test.
 * @returns {boolean} True if script is permitted to execute on URL.
 */
function isRunnableOnUrl(item, url) {
   if (!item) return false;

   const { matches, excludes } = getEffectiveRules(item);
   if (matches.length === 0) return false;

   const isExcluded = excludes.some((rule) => {
      const regex = parseRuleToRegex(rule);
      return regex?.test(url) ?? false;
   });
   if (isExcluded) return false;

   return matches.some((rule) => {
      const regex = parseRuleToRegex(rule);
      return regex?.test(url) ?? false;
   });
}

/**
 * Whether a userstyle should be injected into a frame.
 * Styles that @match only the iframe origin (not the top tab) still apply to that frame.
 * Styles that @match the top page still apply to iframes so @-moz-document blocks can run there.
 *
 * @param {object} style
 * @param {string} frameUrl
 * @param {string} [topUrl]
 * @returns {boolean}
 */
function isStyleApplicableToFrame(style, frameUrl, topUrl) {
   if (frameUrl && isRunnableOnUrl(style, frameUrl)) return true;
   if (topUrl && topUrl !== frameUrl && isRunnableOnUrl(style, topUrl)) return true;
   return false;
}

/**
 * Recursively fetches source code from `@require` URLs using CacheStorage API.
 * Handles cycle detection, stale cache re-validation, and offline network fallbacks.
 *
 * @param {string|string[]} requireUrls Single URL or array of dependency URLs.
 * @param {boolean} [forceBypassCache=false] Force fresh download bypassing cache.
 * @param {Set<string>} [path=new Set()] Cycle detection tracking set.
 * @param {Map<string, boolean>} [visited=new Map()] Processing tracking map.
 * @returns {Promise<string[]>} Ordered array of dependency source codes.
 */
async function fetchRequireCode(requireUrls, forceBypassCache = false, path = new Set(), visited = new Map()) {
   const urls = ensureArray(requireUrls);
   if (!urls.length) return [];

   const allCodeParts = [];
   const cache = await caches.open(REQUIRE_CACHE_NAME);

   for (const url of urls) {
      if (path.has(url)) {
         throw new Error(`Circular @require dependency detected: ${[...path, url].join(' -> ')}`);
      }
      if (visited.has(url)) continue;

      path.add(url);
      visited.set(url, true);

      let libCode;

      // Await existing in-flight request if another script is currently downloading this library
      if (_inFlightRequires.has(url)) {
         libCode = await _inFlightRequires.get(url);
      } else {
         const fetchPromise = (async () => {
            const cachedResponse = await cache.match(url);
            const isStale = cachedResponse ? isCacheStale(cachedResponse) : true;

            // Serve directly from CacheStorage if fresh and not explicitly forced to bypass
            if (!forceBypassCache && cachedResponse && !isStale) {
               return await cachedResponse.text();
            }

            // Attempt network re-fetch for stale/missing entries
            try {
               const response = await fetchWithTimeout(url, { allowedTypes: ALLOWED_SCRIPT_MEDIA_TYPES });
               await cache.put(url, response.clone());
               return await response.text();
            } catch (networkErr) {
               // Fallback to stale cached version if network fetch fails (e.g. offline or SSL error)
               if (cachedResponse) {
                  logger.warn(CONTEXT, `Network fetch failed for @require ${url}. Falling back to stale cache:`, networkErr.message);
                  return await cachedResponse.text();
               }
               throw networkErr;
            }
         })();

         _inFlightRequires.set(url, fetchPromise);
         try {
            libCode = await fetchPromise;
         } finally {
            _inFlightRequires.delete(url);
         }
      }

      const { meta } = MetadataParser.parse(libCode);
      if (meta.require) {
         const nestedCodeParts = await fetchRequireCode(meta.require, forceBypassCache, path, visited);
         allCodeParts.push(...nestedCodeParts);
      }

      // URL-encode sourceURL pragma to prevent syntax errors on special characters
      allCodeParts.push(`${libCode}\n//# sourceURL=${encodeURI(url)}`);
      path.delete(url);
   }

   return [...new Set(allCodeParts)];
}

/**
 * Determines whether a cached HTTP response is stale based on `Cache-Control` headers or age.
 *
 * @param {Response} response Cached HTTP Response object.
 * @returns {boolean} True if cache entry is expired or stale.
 */
function isCacheStale(response) {
   const cacheControl = response.headers.get('Cache-Control');
   if (cacheControl?.includes('no-cache') || cacheControl?.includes('max-age=0')) return true;

   const dateStr = response.headers.get('Date');
   return dateStr ? Date.now() - new Date(dateStr).getTime() > CACHE_MAX_AGE_MS : false;
}

/**
 * Fetches a network resource with an abort timeout and content-type validation.
 *
 * @param {string} url Resource URL to fetch.
 * @param {object} [options] Fetch configuration.
 * @param {number} [options.timeout=8000] Timeout duration in milliseconds.
 * @param {string[]} [options.allowedTypes=[]] Allowed `Content-Type` prefixes.
 * @returns {Promise<Response>} HTTP response object.
 */
async function fetchWithTimeout(url, { timeout = 8000, allowedTypes = [] } = {}) {
   const controller = new AbortController();
   const timeoutId = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeout}ms`)), timeout);

   try {
      const response = await fetch(url, { signal: controller.signal });
      const isDataUri = typeof url === 'string' && url.startsWith('data:');
      if (!response.ok && !isDataUri) {
         throw new Error(`HTTP error! status: ${response.status}`);
      }

      const contentType = response.headers.get('Content-Type') || '';
      if (allowedTypes.length && !isDataUri && !contentTypeMatchesAllowed(contentType, allowedTypes)) {
         throw new Error(`Invalid content type: ${contentType}`);
      }
      return response;
   } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Fetch timed out for ${url}`);
      throw err;
   } finally {
      clearTimeout(timeoutId);
   }
}

/**
 * Fetches a resource and converts it into a Data URL representation.
 *
 * @param {string} resourceUrl Resource URL.
 * @param {object} [options] Options forwarded to `fetchWithTimeout`.
 * @returns {Promise<string|null>} Data URL string or null on error.
 */
async function fetchResourceAsDataUrl(resourceUrl, options = {}) {
   if (!resourceUrl) return null;
   try {
      const response = await fetchWithTimeout(resourceUrl, options);
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
         const reader = new FileReader();
         // Use 'onload' instead of 'onloadend' to avoid null.toString() TypeError when reader fails
         reader.onload = () => resolve(String(reader.result || ''));
         reader.onerror = () => reject(new Error(`FileReader failed for resource: ${resourceUrl}`));
         reader.readAsDataURL(blob);
      });
   } catch (err) {
      logger.warn(CONTEXT, `Failed to fetch resource ${resourceUrl}:`, err.message);
      return null;
   }
}

/**
 * Fetches a script icon as a Data URL, returning a default icon URL on failure or size limit.
 * Hardened with a 20KB size limit to prevent RAM bloat in CacheManager with 300+ scripts
 *
 * @param {string} iconUrl Icon resource URL.
 * @returns {Promise<string>} Data URL or default fallback icon URL.
 */
async function fetchIconAsDataUrl(iconUrl) {
   const MAX_ICON_BYTES = 20000; // 20KB cap for Base64 icon metadata

   if (!iconUrl) return DEFAULT_ICON_URL;

   if (iconUrl.startsWith('data:image')) {
      // Reject massive inline Data URIs to protect SW RAM cache
      return iconUrl.length > MAX_ICON_BYTES ? DEFAULT_ICON_URL : iconUrl;
   }

   const dataUrl = await fetchResourceAsDataUrl(iconUrl, {
      allowedTypes: ['image/', 'image/x-icon', 'application/octet-stream'],
   });

   if (!dataUrl || dataUrl.length > MAX_ICON_BYTES) {
      return DEFAULT_ICON_URL;
   }

   return dataUrl;
}

/**
 * Fetches script GM value storage key-value entries from Dexie database to populate memory cache.
 *
 * @param {object} script Script object.
 * @param {object} meta Parsed script metadata.
 * @returns {Promise<object>} Key-value storage map.
 */
async function getStorageCache(script, meta) {
   const grants = ensureArray(meta?.grant);
   const needsStorage = grants.some(g => [
      'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues',
      'GM.getValue', 'GM.setValue', 'GM.deleteValue', 'GM.listValues'
   ].includes(g));
   if (!needsStorage || typeof script?.id !== 'number') return {};

   try {
      const keys = await agents.listSettings(script.id);
      if (keys.length === 0) return {};

      const entries = await Promise.all(
         keys.map(async (key) => [key, await agents.getSetting(script.id, key)]),
      );
      return Object.fromEntries(entries);
   } catch (err) {
      logger.error(CONTEXT, `Failed to get storage cache for script ${script.id}:`, err);
      return {};
   }
}

/**
 * Constructs injectable code bundles, timing event emulators, and API context wrappers for userscripts.
 *
 * @param {object} script Database script object.
 * @param {object} [options] Build configuration.
 * @param {object} [options.injectionContext={}] Specific injection session parameters.
 * @returns {Promise<object>} Script configuration object ready for Chrome Scripting API injection.
 */
async function buildUserScriptConfig(script, { injectionContext = {} } = {}) {
   const { meta: parsedMeta, metaBlockStr } = MetadataParser.parse(script.userCode);
   const meta = { ...parsedMeta, ...(script.meta || {}) };
   const { matches, excludes } = getEffectiveRules(script);
   const grants = ensureArray(meta.grant);
   const isGrantNone = grants.length === 1 && grants[0] === 'none';
   const scriptName = meta.name || `Script ${script.id}`;

   const requireCodeParts = await fetchRequireCode(meta.require).catch((err) => {
      logger.error(CONTEXT, `Failed to fetch @require for script "${scriptName}":`, err.message);
      throw err;
   });

   const noFramesBlock = meta.noframes ? 'if (window.self !== window.top) { return; }\n' : '';
   const userCodeWrapped = `(function() {${noFramesBlock}\n${script.userCode}\n})();\n//# sourceURL=${encodeURIComponent(scriptName)}.user.js`;

   /**
    * WHY TIMING EMULATION IS REQUIRED:
    * Userscripts often inject at `document_end` or `document_idle` after `DOMContentLoaded` or `load` events
    * have already fired. If a script registers `window.addEventListener('DOMContentLoaded', ...)`, the browser
    * will never trigger the callback natively. Overriding `addEventListener` checks `document.readyState` and
    * dispatches an emulated event asynchronously via `queueMicrotask` to preserve expected userscript execution.
    */
   const timingEmulationWrapper = `
(() => {
   'use strict';
   const hook = (target) => {
      if (!target || target.__litemonkey_emulation_active) return;

      const originalAdd = target.addEventListener;

      Object.defineProperty(target, 'addEventListener', {
         value: function(type, listener, options) {
            const isDOMReady = type === 'DOMContentLoaded' && document.readyState !== 'loading';
            const isLoadReady = type === 'load' && document.readyState === 'complete';

            if (isDOMReady || isLoadReady) {
               const eventType = isDOMReady ? 'DOMContentLoaded' : 'load';
               queueMicrotask(() => {
                  try {
                     const event = new Event(eventType);
                     // Define target properties on the synthetic event
                     Object.defineProperty(event, 'target', { value: target, enumerable: true });
                     Object.defineProperty(event, 'currentTarget', { value: target, enumerable: true });

                     if (typeof listener === 'function') {
                        listener.call(target, event);
                     } else if (listener && typeof listener.handleEvent === 'function') {
                        listener.handleEvent(event);
                     }
                  } catch (err) {
                     console.warn('[LiteMonkey Event Emulator] Failed to trigger event:', err);
                  }
               });
            }
            return originalAdd.apply(this, arguments);
         },
         configurable: true,
         writable: true
      });

      target.__litemonkey_emulation_active = true;
   };

   hook(window);
   hook(document);
})();
//# sourceURL=LiteMonkey-Timing-Hook.js`;

   const fullCodeParts = [];

   // Extract log configuration and pageToken prior to checking grants
   // to ensure availability for both @grant API scripts and @grant none scripts
   const isScriptMuted = Boolean(script.config?.muteLogs);
   const { extension_settings = {} } = await browser.storage.sync.get('extension_settings').catch(() => ({}));
   const areLogsMutedGlobally = Boolean(extension_settings.muteAllLogs);
   const pageToken = injectionContext?.pageToken || '';
   const safeSourceName = encodeURIComponent((scriptName || 'Script').replace(/[^a-zA-Z0-9_-]/g, '_'));
   if (!isGrantNone) {
      const { apiProviderCode, grants: exposedGrants, allowedApis = [] } = generateGmApiCode({ meta });
      const storageCache = await getStorageCache(script, meta);

      // Pre-fetch all @resource files to guarantee synchronous execution of GM_getResourceText/URL
      const resourceCache = {};
      if (meta.resource) {
         for (const [name, url] of Object.entries(meta.resource)) {
            try {
               const [textRes, urlRes] = await Promise.all([
                  fetchWithTimeout(url).then(r => r.text()).catch(() => null),
                  fetchResourceAsDataUrl(url).catch(() => null)
               ]);
               resourceCache[name] = { text: textRes, url: urlRes };
            } catch (e) {
               logger.warn(CONTEXT, `Failed to pre-fetch resource ${name}:`, e);
            }
         }
      }

      const gmContext = {
         ...injectionContext,
         pageToken,
         extensionId: browser.runtime.id,
         scriptId: script.id,
         tabId: injectionContext?.tabId,
         frameId: injectionContext?.frameId ?? 0,
         defaultIconUrl: DEFAULT_ICON_URL,
         MSG,
         meta,
         metaBlockStr,
         manifest,
         storageCache,
         resourceCache,
         allowedApis,
      };

      // Filter out grants containing object dots (e.g. GM.getValue) to avoid JS SyntaxErrors during var generation
      const validVarGrants = exposedGrants.filter(g => !g.includes('.') && /^[$A-Z_][0-9A-Z_$]*$/i.test(g));

      // Build clean parameter and argument lists to prevent trailing comma SyntaxErrors when validVarGrants is empty
      const wrapperParams = ['window', 'document', 'GM', 'console', ...validVarGrants].join(', ');
      const wrapperArgs = ['window', 'document', 'GM_API', 'scriptConsole', ...validVarGrants.map(g => `GM_API['${g}']`)].join(', ');

      // Lexical scoping wrapper. Eliminates window.GM pollution and Sandbox Escapes.
      // All @require libraries and the user script are executed within the SAME closure,
      // allowing them to share the GM API securely without exposing it to the host page.
      const apiWrapperStart = `
((GM_CONTEXT) => {
   const GM_API = (${apiProviderCode})(GM_CONTEXT);
   const GM = GM_API;

   // Extract requested grants into local variables for legacy script compatibility
   ${validVarGrants.map(g => `const ${g} = GM_API['${g}'];`).join('\n')}

   const scriptConsole = ${generateLogWrapperCode({ scriptId: script.id, pageToken, areLogsMutedGlobally, isScriptMuted, scriptName })};

   try {
      // Create a secure execution boundary with scriptConsole shadowing global console
      (function(${wrapperParams}) {
         ${noFramesBlock}
`;

      const apiWrapperEnd = `
      })(${wrapperArgs});
   } catch (e) {
      console.error('[LiteMonkey] Script execution error:', e);
   }
})(${JSON.stringify(gmContext)});
//# sourceURL=${safeSourceName}-API-Wrapper.js`;

      fullCodeParts.push(
         timingEmulationWrapper,
         apiWrapperStart,
         ...requireCodeParts,
         script.userCode,
         apiWrapperEnd
      );
   } else {
      // Pass scriptConsole to @grant none scripts using the outer pageToken and settings
      // const scriptConsole = generateLogWrapperCode({ scriptId: script.id, pageToken, areLogsMutedGlobally, isScriptMuted, scriptName });
      const scriptConsoleCode = generateLogWrapperCode({ scriptId: script.id, pageToken, areLogsMutedGlobally, isScriptMuted, scriptName });
      const userCodeWrapped = `
(() => {
   const scriptConsole = ${scriptConsoleCode};
   (function(console) {
      ${noFramesBlock}
      ${script.userCode}
   })(scriptConsole);
})();
//# sourceURL=${safeSourceName}.user.js`;
      fullCodeParts.push(timingEmulationWrapper, ...requireCodeParts, userCodeWrapped);
   }

   return {
      id: `userscript-${script.id}`,
      matches: matches.length ? matches : ensureArray(meta.match),
      excludeMatches: excludes.length ? excludes : ensureArray(meta.exclude),
      runAt: getScriptRunAt(meta['run-at']),
      fullCode: fullCodeParts.filter(Boolean).join('\n\n'),
   };
}

/**
 * Performs static analysis on userscript source code to detect security anomalies or high-risk patterns.
 * Compares updated script code against previous versions to detect newly introduced risks.
 *
 * @param {string} newCode Updated script code.
 * @param {object|null} [oldScript=null] Previous script object for baseline comparison.
 * @returns {string[]} Array of detected anomaly flags.
 */
function analyzeScriptAnomalies(newCode, oldScript = null) {
   const anomalies = [];
   if (!newCode) return anomalies;

   // Strip JavaScript single-line and multi-line comments before analyzing security anomalies
   // Use negative lookbehind (?<!:) to ensure protocol slashes (http://, https://) are preserved
   const codeWithoutComments = newCode
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(?<!:)\/\/.*/g, '');

   // Search for dynamic code execution signatures (eval, new Function, indirect Function calls)
   const dynamicCodeRegex = /eval\s*\(|new\s+Function\s*\(|Function\s*\([^)]*\)\s*\(/i;
   const hasDynamic = dynamicCodeRegex.test(codeWithoutComments);

   if (hasDynamic) {
      const oldCodeWithoutComments = oldScript
         ? (oldScript.userCode || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*/g, '')
         : '';
      const hadDynamicBefore = oldScript ? dynamicCodeRegex.test(oldCodeWithoutComments) : false;

      if (oldScript && !hadDynamicBefore) {
         anomalies.push('new_eval_detected');
      } else if (!oldScript) {
         anomalies.push('eval_detected');
      }
   }

   // Detect aggressive hex escape obfuscation (e.g., heavy \x41\x42... string encoding)
   const hexEscapes = (codeWithoutComments.match(/\\x[0-9a-f]{2}/gi) || []).length;
   if (hexEscapes > 150) {
      anomalies.push('high_obfuscation_risk');
   }

   return anomalies;
}

export default {
   // --- Core Logic Helpers ---
   buildUserScriptConfig,
   handlePermissionCheck,
   isRunnableOnUrl,
   isStyleApplicableToFrame,
   getEffectiveRules,
   extractMatchPatternsFromStyle,
   classifyMatchRulesForPermissions,

   // --- Pattern & String Utilities ---
   parseRuleToRegex,
   wildcardToRegex,
   ensureArray,

   // --- Network & Caching Operations ---
   fetchRequireCode,
   fetchResourceAsDataUrl,
   fetchIconAsDataUrl,
   fetchWithTimeout,
   isCacheStale,

   analyzeScriptAnomalies,
};
