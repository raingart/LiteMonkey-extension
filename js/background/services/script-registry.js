import browser from '../../libs/browser-support.js';
import { agents } from '../../database.js';
import { ErrorCollector } from '../../libs/error-collector.js';
import { MetadataParser } from '../../libs/meta-parser.js';
import CacheManager from './cache-manager.js';
import ApiHandler from './gm-api-handler.js';
import Utils from '../utils.js';
import { logger } from '../../libs/logger.js';
import { TRUSTED_SCRIPT_HOSTS, MAX_SCRIPT_SIZE, isRestrictedUrl, isTrustedScriptHost } from '../../constants.js';
import { normalizeCustomUrlsExcludes } from '../../libs/origin-guard.js';

const CONTEXT = 'ScriptRegistry';

/**
 * Generates a cryptographically secure random UUID for session token authentication.
 * @returns {string} Standard UUID v4 string.
 */
function generateSecureUUID() {
   return crypto.randomUUID();
}

/**
 * Validates that the script source code does not exceed maximum permitted size.
 *
 * @param {string} code The script's JavaScript source code.
 * @throws {Error} If code size exceeds MAX_SCRIPT_SIZE.
 */
function validateScriptSize(code) {
   if (new Blob([code]).size > MAX_SCRIPT_SIZE) {
      const maxSizeMB = MAX_SCRIPT_SIZE / 1024 / 1024;
      throw new Error(`Script code is too large. The maximum allowed size is ${maxSizeMB}MB.`);
   }
}

/**
 * Resolves the execution target context (tab, frame, URL) from message sender or active tab.
 *
 * @param {string} [url] Target URL override.
 * @param {browser.runtime.MessageSender} [sender] Message sender metadata.
 * @param {object} [payload] Optional payload containing tabId.
 * @returns {Promise<{targetTab: object, targetFrameId: number, targetUrl: string}|null>} Resolved target context.
 */
async function resolveTargetContext(url, sender, payload = {}) {
   const tabId = payload?.tabId ?? sender?.tab?.id;
   const targetUrl = url ?? sender?.url ?? sender?.tab?.url;

   if (tabId && targetUrl) {
      return {
         targetTab: { id: tabId, url: targetUrl },
         targetFrameId: sender?.frameId ?? 0,
         targetUrl,
      };
   }

   try {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
         return {
            targetTab: activeTab,
            targetFrameId: 0,
            targetUrl: targetUrl ?? activeTab.url,
         };
      }
   } catch { }

   return null;
}

/**
 * Central manager for userscript operations.
 * Handles script installation, persistent updates, execution injection, and permission checks.
 */
const ScriptRegistry = {
   /**
    * Checks if an installer URL originates from a trusted domain.
    *
    * @param {string} installerUrl The URL initiating script installation.
    * @returns {boolean} True if domain is on TRUSTED_SCRIPT_HOSTS list.
    * @private
    */
   _isSourceTrusted(installerUrl) {
      if (!installerUrl) return false;
      try {
         const { hostname } = new URL(installerUrl);
         return [...TRUSTED_SCRIPT_HOSTS].some(
            (trustedHost) => hostname === trustedHost || hostname.endsWith(`.${trustedHost}`),
         );
      } catch {
         return false; // Invalid URL structure
      }
   },

   /**
    * Safely builds script execution configuration and captures non-fatal errors (e.g. @require resource loading).
    *
    * @param {object} script Script model object.
    * @returns {Promise<{ config: object|null, error: string|null }>} Safe configuration result.
    * @private
    */
   async _buildConfigSafe(script) {
      try {
         const config = await Utils.buildUserScriptConfig(script);
         return { config, error: null };
      } catch (err) {
         ErrorCollector.captureAndReport(err, { trace_name: '_buildConfigSafe', scriptId: script.id });
         return { config: null, error: err?.message ?? 'config build failed' };
      }
   },

   /**
    * Persists script changes, preserves UUIDs, performs static security analysis, and caches icons.
    *
    * @param {object} scriptToSave The script object to save.
    * @returns {Promise<{ success: boolean, script: object }>} Saved script wrapped in result status.
    * @private
    */
   async _persistAndRegister(scriptToSave) {
      const script = { ...scriptToSave };

      // Preserve existing script UUID across updates
      let oldScript = null;
      if (script.id) {
         try {
            oldScript = await agents.getFullScript(script.id);
            if (oldScript?.uuid) {
               script.uuid = oldScript.uuid;
            }
         } catch (err) {
            logger.error(CONTEXT, 'Failed to fetch old script for UUID preservation:', err);
         }
      }

      if (!script.state) script.state = {};

      this._inferUserstyleMetadata(script);

      // Validate required resources (@require, @resource) if enabled and error-free
      if (script.enabled) {
         script.state.registrationError = null;
         const { error: buildError } = await this._buildConfigSafe(script);
         if (buildError) {
            script.state.registrationError = buildError;
         }
      }

      // Static code analysis for security anomalies
      const anomalies = Utils.analyzeScriptAnomalies(script.userCode, oldScript);
      script.state.anomalies = anomalies;

      // Cache icon image in Base64 format if specified
      if (script.meta?.icon && !script.iconDataUrl) {
         try {
            script.iconDataUrl = await Utils.fetchIconAsDataUrl(script.meta.icon);
         } catch {
            script.iconDataUrl = null;
         }
      }

      const savedId = await agents.put(script);
      const fullScript = await agents.getFullScript(savedId);

      return { success: true, script: fullScript };
   },

   /**
    * Imports scripts directly during backup restoration or migration.
    * @param {object[]} [scripts=[]] Array of raw script objects to import.
    * @returns {Promise<{ success: boolean, count: number }>} Import result summary.
    */
   async importScripts(scripts = []) {
      // Map existing scripts by name and namespace to update existing records instead of duplicating
      const allExisting = await agents.getAllMeta();
      const existingMap = new Map(
         allExisting.map(s => [`${s.meta?.name || ''}|${s.meta?.namespace || ''}`, s])
      );

      const baseTimestamp = Date.now();

      const preparedScripts = await Promise.all(
         scripts.map(async ({ userCode = '', position, config, wasEnabled, meta, customUrls, storage, type, sourceUrl }, index) => {
            validateScriptSize(userCode);

            const key = `${meta?.name || ''}|${meta?.namespace || ''}`;
            const existing = existingMap.get(key);

            // Remove matched script from map to prevent duplicate ID/UUID assignment on identical imports
            if (existing) {
               existingMap.delete(key);
            }

            // Reuse existing primary key ID and UUID to perform overwrite/update
            const scriptObject = {
               id: existing?.id,
               uuid: existing?.uuid || crypto.randomUUID(),
               userCode,
               position: position ?? existing?.position ?? (baseTimestamp + index),
               config: config || existing?.config,
               meta,
               type,
               customUrls: customUrls !== undefined ? customUrls : (existing?.customUrls ?? null),
               sourceUrl: sourceUrl !== undefined ? sourceUrl : (existing?.sourceUrl ?? null),
               storage: storage || {} // Attach storage object to prepared script
            };

            this._inferUserstyleMetadata(scriptObject);

            const permResult = await Utils.handlePermissionCheck(scriptObject);

            if (wasEnabled) {
               if (permResult) {
                  scriptObject.enabled = false;
                  scriptObject.state = { permissionError: true };
                  if (permResult.unrequestable) {
                     scriptObject.state.registrationError = permResult.error;
                  }
               } else {
                  scriptObject.enabled = true;
               }
            } else {
               scriptObject.enabled = false;
            }
            return scriptObject;
         }),
      );

      await agents.bulkPut(preparedScripts);

      // Restore GM_storage key-value pairs in Dexie DB for all imported scripts
      for (const item of preparedScripts) {
         if (item.storage && typeof item.storage === 'object' && Object.keys(item.storage).length > 0) {
            const saved = (await agents.getAllMeta()).find(m => m.uuid === item.uuid);
            if (saved?.id) {
               await agents.setFullStorage(saved.id, item.storage);
            }
         }
      }

      return { success: true, count: preparedScripts.length };
   },

   /**
    * Installs a userscript from source code and metadata headers.
    *
    * @param {object} payload Installation details.
    * @param {string} payload.userCode Source code of the script.
    * @param {string} [payload.sourceUrl] URL where script was downloaded from.
    * @param {number} [payload.existingId] Existing script ID to replace.
    * @param {string} [payload.installerUrl] URL of the page initiating installation.
    * @returns {Promise<object>} Installation status object.
    */
   async installScript({ userCode, sourceUrl, existingId, installerUrl }) {
      if (!userCode) throw new Error('userCode is required for installation.');
      validateScriptSize(userCode);

      const { meta, type } = MetadataParser.parse(userCode);
      if (!meta.name) throw new Error('Invalid script metadata: missing @name.');

      const scriptObject = {
         id: existingId,
         userCode,
         meta,
         type,
         enabled: true,
         state: {},
         sourceUrl,
      };

      this._inferUserstyleMetadata(scriptObject);

      const permResult = await Utils.handlePermissionCheck(scriptObject);

      if (permResult) {
         if (permResult.unrequestable) {
            // Invalid match pattern (e.g. invalid regex) forces disabled state with error
            scriptObject.enabled = false;
            scriptObject.state.permissionError = false;
            scriptObject.state.registrationError = permResult.error;
         } else {
            // Forward required permissions info to frontend installer without blocking
            const isTrusted = this._isSourceTrusted(sourceUrl) || this._isSourceTrusted(installerUrl);
            return { success: true, needsPermissions: true, details: permResult, scriptObject, isTrusted };
         }
      }

      return this._persistAndRegister(scriptObject);
   },

   /**
    * Creates or updates a script from user-edited source code.
    *
    * @param {object} scriptObject Script object containing modified `userCode`.
    * @returns {Promise<object>} Save result object.
    */
   async createOrUpdateFromSource(scriptObject) {
      validateScriptSize(scriptObject.userCode);
      const { meta: parsedMeta, type } = MetadataParser.parse(scriptObject.userCode);

      // Preserve editor metadata priority over raw header metadata
      const mergedMeta = {
         ...parsedMeta,
         ...(scriptObject.meta || {}),
      };

      const updatedScript = {
         ...scriptObject,
         meta: mergedMeta,
         type,
         updatedAt: Date.now(),
      };
      if (!updatedScript.state) updatedScript.state = {};

      const permResult = await Utils.handlePermissionCheck(updatedScript);

      if (permResult?.unrequestable) {
         updatedScript.enabled = false;
         updatedScript.state.registrationError = permResult.error;
         updatedScript.state.permissionError = false;
         return this._persistAndRegister(updatedScript);
      }

      updatedScript.state.registrationError = null;

      if (updatedScript.enabled) {
         if (permResult) {
            return { success: true, needsPermissions: true, details: permResult };
         }
         updatedScript.state.permissionError = false;
      }

      return this._persistAndRegister(updatedScript);
   },

   /**
    * Saves a pre-parsed and validated script.
    *
    * @param {object} preparedScript Script object with validated `meta` and `userCode`.
    * @returns {Promise<object>} Persist status object.
    */
   async createOrUpdateFromPrepared(preparedScript) {
      if (!preparedScript?.meta || typeof preparedScript.userCode !== 'string') {
         throw new Error('Invalid argument: A prepared script object with `meta` and `userCode` is required.');
      }
      return this._persistAndRegister(preparedScript);
   },

   /**
    * Updates general properties of a script (e.g. state, enabled flag, config).
    *
    * @param {number} scriptId Script ID.
    * @param {object} [props={}] Property mutations.
    * @returns {Promise<object>} Update status object.
    */
   async updateScriptProperties(scriptId, props = {}) {
      const script = await agents.getFullScript(scriptId);
      if (!script) throw new Error(`Script with ID ${scriptId} not found.`);

      // Automatically normalize root-level config properties (muteLogs, syncStorage) into nested config
      const incomingConfig = { ...props.config };
      if ('muteLogs' in props) incomingConfig.muteLogs = props.muteLogs;
      if ('syncStorage' in props) incomingConfig.syncStorage = props.syncStorage;

      const updated = {
         ...script,
         ...props,
         config: { ...script.config, ...incomingConfig },
         state: { ...script.state, ...props.state },
      };
      delete updated.muteLogs;
      delete updated.syncStorage;

      if (props.enabled === true) {
         const permResult = await Utils.handlePermissionCheck(updated);
         if (permResult) {
            if (permResult.unrequestable) {
               updated.enabled = false;
               updated.state.permissionError = false;
               updated.state.registrationError = permResult.error;
               return this._persistAndRegister(updated);
            }
            return { success: true, needsPermissions: true, details: permResult };
         }

         updated.state.permissionError = false;
      }

      return this._persistAndRegister(updated);
   },

   /**
    * Removes a script from storage, cleans up associated commands, and purges orphaned @require caches.
    *
    * @param {number} scriptId ID of the script to delete.
    * @returns {Promise<{ success: boolean }>} Deletion result status.
    */
   async delete(scriptId) {
      // Fetch full script metadata before deletion to locate used @require URLs
      const script = await agents.getFullScript(scriptId).catch(() => null);

      await ApiHandler.clearCommandsForScript(scriptId);
      await agents.delete(scriptId);

      // Purge orphaned @require library entries from CacheStorage if no other active script relies on them
      if (script?.meta?.require) {
         try {
            const deletedRequires = [script.meta.require].flat().filter(Boolean);
            const remainingScripts = (await CacheManager.get()).filter((s) => s.id !== scriptId);
            const activeRequires = new Set(
               remainingScripts.flatMap((s) => [s.meta?.require].flat().filter(Boolean))
            );

            const trulyObsolete = deletedRequires.filter((url) => !activeRequires.has(url));
            if (trulyObsolete.length > 0) {
               const cache = await caches.open('require-cache');
               await Promise.all(trulyObsolete.map((url) => cache.delete(url)));
               logger.debug(CONTEXT, `Purged ${trulyObsolete.length} orphaned @require cache entries.`);
            }
         } catch (err) {
            logger.warn(CONTEXT, 'Failed to cleanup orphaned @require caches on script delete:', err);
         }
      }

      return { success: true };
   },

   /**
    * Fills UserStyle type and @match from @-moz-document when the header omitted them.
    * @private
    */
   _inferUserstyleMetadata(script) {
      const userCode = script.userCode || '';
      if (!userCode) return;

      const parsed = MetadataParser.parse(userCode);
      if (!script.type || script.type === 'userscript') {
         if (parsed.type === 'userstyle') script.type = 'userstyle';
      }

      const meta = script.meta || {};
      const hasMatch = [].concat(meta.match || [], meta.include || []).some(Boolean);
      if (hasMatch) return;

      const inferred = Utils.extractMatchPatternsFromStyle(userCode);
      if (inferred.length) {
         script.meta = { ...meta, match: inferred };
      }
   },

   /**
    * Queries scripts matching a specific URL, handling global extension pause states.
    *
    * @param {string} url Target URL.
    * @param {object} [options] Filtering options.
    * @param {boolean} [options.requireEnabled=false] Require script to be enabled.
    * @param {number|null} [options.tabId=null] Target tab ID for reading menu commands.
    * @returns {Promise<{ scripts: object[], isPaused: boolean }>} Matching scripts and pause status.
    * @private
    */
   async _getScriptsForUrl(url, { requireEnabled = false, tabId = null, ignorePause = false } = {}) {
      const getPauseState = async () => {
         try {
            if (browser.storage?.session) {
               const data = await browser.storage.session.get({ isPaused: false });
               return data.isPaused;
            }
         } catch {
            // Ignore missing storage API errors
         }
         return false;
      };

      const [isPaused, allScripts, tabMenuCommands] = await Promise.all([
         getPauseState(),
         CacheManager.get(),
         tabId ? ApiHandler.getCommandsForTab(tabId) : Promise.resolve({}),
      ]);

      if (!ignorePause && isPaused) return { scripts: [], isPaused: true };

      const matchingScripts = allScripts.filter((script) => {
         const isRunnable = Utils.isRunnableOnUrl(script, url);
         if (requireEnabled) {
            return script.enabled && isRunnable;
         }
         if (isRunnable) return true;

         // For popup listing: include if script has a custom exclusion rule matching this URL, OR if meta match rules match this URL
         const hasMatchingExclusion = (normalizeCustomUrlsExcludes(script.customUrls) || '')
            .split('\n')
            .map((s) => s.trim())
            .filter((l) => l.startsWith('-'))
            .some((l) => {
               const regex = Utils.parseRuleToRegex(l.substring(1));
               return regex?.test(url) ?? false;
            });

         if (hasMatchingExclusion) return true;

         return Utils.isRunnableOnUrl({ meta: script.meta }, url);
      });

      const scriptsForPage = matchingScripts.map(({ userCode, ...rest }) => ({
         ...rest,
         commands: tabMenuCommands[rest.id] || tabMenuCommands[String(rest.id)] || [],
      }));

      return { scripts: scriptsForPage, isPaused };
   },

   /**
    * Returns enabled scripts applicable to a URL.
    *
    * @param {string} url Target webpage URL.
    * @returns {Promise<{ scripts: object[], isPaused: boolean }>} Active scripts list.
    */
   async getActiveScriptsForUrl(url) {
      return url
         ? this._getScriptsForUrl(url, { requireEnabled: true })
         : { scripts: [], isPaused: true };
   },

   /**
    * Gets active scripts decorated with target tab context for bootstrap initialization.
    *
    * @param {string} url Webpage URL.
    * @param {browser.runtime.MessageSender} sender Sender metadata.
    * @returns {Promise<{ scripts: object[], isPaused: boolean }>} Decorated active scripts list.
    */
   async getActiveScriptsForBootstrap(url, sender) {
      if (!sender?.tab) return { scripts: [], isPaused: true };

      const { scripts, isPaused } = await this.getActiveScriptsForUrl(url);
      if (isPaused) return { scripts: [], isPaused: true };

      const isSubframe = (sender.frameId ?? 0) !== 0;

      // Userstyles are injected via StyleInjector (insertCSS), not the JS bootstrap pipeline
      const scriptsForPage = scripts
         .filter((script) => script.type !== 'userstyle')
         .filter((script) => !isSubframe || !script.meta?.noframes)
         .map((script) => ({
            ...script,
            tabId: sender.tab.id,
            frameId: sender.frameId ?? 0,
         }));

      return { scripts: scriptsForPage, isPaused: false };
   },

   /**
    * Returns all scripts (both enabled and disabled) applicable to a given URL.
    *
    * @param {string} url Webpage URL.
    * @param {browser.runtime.MessageSender} [sender] Message sender.
    * @param {object} [payload] Optional request payload.
    * @returns {Promise<{ scripts: object[], isPaused: boolean }>} Matching scripts.
    */
   async getApplicableScriptsForURL(url, sender, payload = {}) {
      const context = await resolveTargetContext(url, sender, payload);
      if (!context?.targetUrl) return { scripts: [], isPaused: false };

      return this._getScriptsForUrl(context.targetUrl, {
         requireEnabled: false,
         tabId: context.targetTab?.id,
         ignorePause: true,
      });
   },

   /**
    * Finds an existing script by matching name and optional namespace metadata.
    *
    * @param {string} name Metadata @name.
    * @param {string} [namespace] Metadata @namespace.
    * @returns {Promise<{ id: number, version: string }|null>} Found script summary or null.
    */
   async findExistingScript(name, namespace) {
      const allScripts = await CacheManager.get();
      const cleanName = (name || '').trim();
      const cleanNamespace = (namespace || '').trim();

      const foundScript = allScripts.find((s) => {
         const sName = (s.meta?.name || '').trim();
         const sNs = (s.meta?.namespace || '').trim();
         if (sName !== cleanName) return false;
         // Match if namespace is empty/omitted or exact match
         return !cleanNamespace || !sNs || sNs === cleanNamespace;
      });

      return foundScript ? { id: foundScript.id, version: foundScript.meta?.version ?? '1.0.0' } : null;
   },

   /**
    * Executes a user script in a specified tab/frame via Chrome Scripting or userScripts API.
    *
    * @param {number} scriptId Script ID to execute.
    * @param {{ tabId: number, frameId: number }} target Target tab and frame identifiers.
    * @param {object} injectionContext Context parameters including session security tokens.
    */
   async executeScriptInTab(scriptId, target, injectionContext) {
      if (typeof target?.tabId !== 'number') {
         logger.warn(CONTEXT, `executeScriptInTab called with invalid target for script ${scriptId}`, { target });
         return;
      }

      logger.debug(CONTEXT, `Executing script ${scriptId} in tab ${target.tabId}, frame ${target.frameId}`);

      try {
         const script = await agents.getFullScript(scriptId);
         if (!script) {
            logger.warn(CONTEXT, `Script ${scriptId} not found for execution.`);
            return;
         }
         if (!script.enabled) {
            logger.debug(CONTEXT, `Script ${scriptId} is disabled, skipping execution.`);
            return;
         }

         // Safely determine target URL using IPC sender URL first to bypass missing 'tabs' permission limits
         let currentUrl = injectionContext?.url;
         if (!currentUrl) {
            try {
               const tab = await browser.tabs.get(target.tabId);
               currentUrl = tab?.url;
            } catch (e) {
               logger.debug(CONTEXT, `Could not retrieve tab URL for tab ${target.tabId}:`, e);
            }
         }

         // Properly validate URL without triggering ReferenceError
         if (!currentUrl || isRestrictedUrl(currentUrl) || !Utils.isRunnableOnUrl(script, currentUrl)) {
            logger.warn(CONTEXT, `Aborting injection: Script ${scriptId} is not allowed on URL ${currentUrl}`);
            return;
         }

         // Generate/reuse secure session token for tab + frame + script tuple
         const pageToken = injectionContext?.pageToken || generateSecureUUID();
         const secureContext = {
            ...injectionContext,
            pageToken,
            tabId: target.tabId,
            frameId: target.frameId ?? 0,
         };
         const sessionKey = `token_${target.tabId}_${target.frameId || 0}_${scriptId}`;

         // Ensure token is persisted before dispatching injection to avoid verification race conditions
         if (!globalThis.__litemonkey_tokens) globalThis.__litemonkey_tokens = {};
         globalThis.__litemonkey_tokens[sessionKey] = pageToken;

         try {
            if (browser.storage?.session) {
               await browser.storage.session.set({ [sessionKey]: pageToken });
            } else {
               await browser.storage.local.set({ [sessionKey]: pageToken });
            }
         } catch (e) {
            logger.warn(CONTEXT, 'Storage session/local write failed, relying on RAM cache.', e);
         }

         const config = await Utils.buildUserScriptConfig(script, { injectionContext: secureContext });

         if (config?.fullCode) {
            const injectInto = script.meta?.['inject-into'] || script.meta?.['inject_into'];
            const targetWorld = (injectInto === 'content' || injectInto === 'isolated')
               ? 'ISOLATED'
               : 'MAIN';

            // Priority #1 - Native Chrome MV3 userScripts API (Chrome 120+) ONLY for ISOLATED world execution
            if (targetWorld === 'ISOLATED' && typeof chrome !== 'undefined' && chrome.userScripts?.execute) {
               try {
                  await chrome.userScripts.execute({
                     target: {
                        tabId: target.tabId,
                        frameIds: [target.frameId ?? 0],
                     },
                     world: 'USER_SCRIPT',
                     js: [{ code: config.fullCode }],
                  });
                  logger.debug(CONTEXT, `Executed script ${scriptId} via native userScripts API in USER_SCRIPT world.`);
                  return;
               } catch (userScriptErr) {
                  logger.warn(CONTEXT, `userScripts API execution failed, falling back to scripting.executeScript:`, userScriptErr);
               }
            }

            // Priority #2 - Universal scripting.executeScript fallback
            // injectImmediately: bootstrap already raced past document_start; do not wait for document_idle
            const execOptions = {
               target: {
                  tabId: target.tabId,
                  frameIds: [target.frameId ?? 0],
               },
               world: targetWorld,
               injectImmediately: true,
               func: (code, isIsolated) => {
                  if (isIsolated) {
                     try {
                        const blob = new Blob([code], { type: 'text/javascript' });
                        const url = URL.createObjectURL(blob);
                        import(url)
                           .catch(() => {
                              // Fallback execution if dynamic module import is blocked by CSP
                              try {
                                 (0, eval)(code);
                              } catch (evalErr) {
                                 console.error('[LiteMonkey] Isolated execution fallback failed:', evalErr);
                              }
                           })
                           // Single, clean .finally() for Blob URL memory cleanup
                           .finally(() => URL.revokeObjectURL(url));
                     } catch (e) {
                        console.error('[LiteMonkey] Blob creation blocked in isolated world:', e);
                     }
                     return;
                  }

                  // MAIN world execution via standard <script> tag injection
                  const scriptEl = document.createElement('script');
                  let scriptValue = code;

                  // 1. Attempt Trusted Types policy creation for sites requiring TrustedScript
                  if (window.trustedTypes && window.trustedTypes.createPolicy) {
                     try {
                        const randomSuffix = Math.floor(Math.random() * 1000000);
                        const policyName = `litemonkey-${randomSuffix}`;
                        const policy = window.trustedTypes.createPolicy(policyName, {
                           createScript: (string) => string,
                        });
                        scriptValue = policy.createScript(code);
                     } catch (e) {
                        const defaultPolicy = window.trustedTypes.defaultPolicy;
                        if (defaultPolicy?.createScript) {
                           try {
                              scriptValue = defaultPolicy.createScript(code);
                           } catch (err) { }
                        }
                     }
                  }

                  try {
                     // 2. Direct DOM injection (works on 99% of web pages)
                     scriptEl.textContent = scriptValue;
                     const targetContainer = document.head || document.documentElement || document.body;
                     if (targetContainer) {
                        targetContainer.append(scriptEl);
                        scriptEl.remove();
                     }
                  } catch (typeError) {
                     // 3. Fallback for ultra-strict CSP blocking inline script execution
                     try {
                        const blob = new Blob([code], { type: 'text/javascript' });
                        const url = URL.createObjectURL(blob);
                        import(url)
                           .then(() => { URL.revokeObjectURL(url); })
                           .catch((importErr) => {
                              console.error('[LiteMonkey] Dynamic module import failed:', importErr);
                              URL.revokeObjectURL(url);
                           });
                     } catch (blobErr) {
                        console.error('[LiteMonkey] Trusted Types blocked all injection methods.', blobErr);
                     }
                  }
               },
               args: [config.fullCode, targetWorld === 'ISOLATED'],
            };

            try {
               await browser.scripting.executeScript(execOptions);
            } catch (injectErr) {
               // Firefox < 128 rejects unknown injectImmediately; retry without it
               if (execOptions.injectImmediately) {
                  delete execOptions.injectImmediately;
                  await browser.scripting.executeScript(execOptions);
               } else {
                  throw injectErr;
               }
            }
            logger.debug(CONTEXT, `Injection command sent for script ${scriptId} in tab ${target.tabId}.`);
         } else {
            logger.warn(CONTEXT, `Build config failed or produced no code for script ${scriptId}.`);
         }
      } catch (err) {
         logger.error(CONTEXT, `Execution failed for script ${scriptId}:`, err);
      }
   }
};

export default ScriptRegistry;
