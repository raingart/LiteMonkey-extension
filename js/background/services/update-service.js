import { agents } from '../../database.js';
import { MetadataParser } from '../../libs/meta-parser.js';
import ScriptRegistry from './script-registry.js';
import Utils from '../utils.js';
import { logger } from '../../libs/logger.js';
import CacheManager from './cache-manager.js';

const CONTEXT = 'UpdateService';

/**
 * Concurrency limit for background script update HTTP checks.
 * Prevents flooding network connection pools and hitting host rate limits during bulk update checks.
 */
const CONCURRENT_LIMIT = 5;

const ALLOWED_SCRIPT_CONTENT_TYPES = ['text/', 'application/javascript', 'application/x-javascript'];

/**
 * Defensive normalization helper extracting a single scalar string from strings or arrays.
 * @param {any} val
 * @returns {string}
 */
const toScalarString = (val) => {
   if (Array.isArray(val)) return String(val[val.length - 1] ?? '').trim();
   if (val == null) return '';
   return String(val).trim();
};

/**
 * Compares two semantic version strings (e.g., "1.2.3-beta.2" vs "1.3.0").
 * @param {string|Array<string>} versionA - Current version.
 * @param {string|Array<string>} versionB - Remote version.
 * @returns {number} Positive number if versionB is newer, negative if versionA is newer, or 0 if equal.
 */
const compareSemanticVersions = (versionA, versionB) => {
   // Coerce input operands into guaranteed scalar strings
   const strA = toScalarString(versionA);
   const strB = toScalarString(versionB);

   // Normalize versions: trim whitespace and strip leading 'v' or 'V' prefixes
   const safeA = (strA || '0').replace(/^v/i, '');
   const safeB = (strB || '0').replace(/^v/i, '');

   const [mainA, preA = ''] = safeA.split('-');
   const [mainB, preB = ''] = safeB.split('-');

   const partsA = mainA.split('.').map(Number).filter(Number.isFinite);
   const partsB = mainB.split('.').map(Number).filter(Number.isFinite);
   const maxLength = Math.max(partsA.length, partsB.length);

   for (let i = 0; i < maxLength; i++) {
      const partA = partsA[i] ?? 0;
      const partB = partsB[i] ?? 0;
      if (partB > partA) return 1;
      if (partA > partB) return -1;
   }

   // According to SemVer spec, a release version (no pre-release) is NEWER than a pre-release version
   if (preA && !preB) return 1;
   if (!preA && preB) return -1;
   if (preA && preB) return preB.localeCompare(preA, undefined, { numeric: true });

   return 0;
};

/**
 * Creates a promise-queue concurrency limiter for asynchronous network tasks.
 * @param {number} concurrency - Maximum number of simultaneous async tasks.
 * @returns {function(function(): Promise<*>): Promise<*>} Concurrency wrapper function.
 */
const createConcurrencyLimiter = (concurrency) => {
   const queue = [];
   let activeCount = 0;

   const runNext = () => {
      if (activeCount >= concurrency || !queue.length) return;
      activeCount++;
      const { task, resolve, reject } = queue.shift();
      task()
         .then(resolve, reject)
         .finally(() => {
            activeCount--;
            runNext();
         });
   };

   return (task) =>
      new Promise((resolve, reject) => {
         queue.push({ task, resolve, reject });
         Promise.resolve().then(runNext);
      });
};

/**
 * Removes obsolete `@require` dependency URLs from CacheStorage when scripts are updated.
 * @param {Array<string>|string} oldRequires - Previous `@require` directive URLs.
 * @param {Array<string>|string} newRequires - Updated `@require` directive URLs.
 * @returns {Promise<void>}
 */
const cleanupObsoleteDependencies = async (scriptId, oldRequires, newRequires) => {
   const oldUrls = new Set([oldRequires].flat().filter(Boolean));
   const newUrls = new Set([newRequires].flat().filter(Boolean));
   const urlsToClean = [...oldUrls].filter((url) => !newUrls.has(url));
   if (!urlsToClean.length) return;

   try {
      //  Cross-reference ALL active scripts to prevent deleting shared @require libraries
      const allScripts = await CacheManager.get();
      const activeRequires = new Set(
         allScripts
            .filter((s) => s.id !== scriptId) // Ignore stale metadata of the script being updated
            .flatMap((s) => [s.meta?.require].flat().filter(Boolean))
      );

      // Ensure new dependencies of the current script are protected
      newUrls.forEach(url => activeRequires.add(url));

      const trulyObsolete = urlsToClean.filter((url) => !activeRequires.has(url));

      if (trulyObsolete.length > 0) {
         const cache = await caches.open('require-cache');
         await Promise.all(trulyObsolete.map((url) => cache.delete(url)));
         logger.debug(CONTEXT, `Cleaned ${trulyObsolete.length} obsolete @require cache entries.`);
      }
   } catch (error) {
      logger.warn(CONTEXT, `Failed to clean obsolete dependencies: ${error.message}`);
   }
};

/**
 * Service managing background update checks, version comparisons, and atomic upgrades for userscripts.
 */
const UpdateService = {
   /** @private */
   _isUpdateInProgress: false,

   /**
    * Checks for updates across all enabled scripts specifying an `@updateURL` or `@downloadURL`.
    * Uses a concurrency limiter to throttle network requests.
    * @returns {Promise<{updated: number, failed: number, updatedIds: Array<number>, inProgress?: boolean}>}
    */
   async checkForUpdates() {
      if (this._isUpdateInProgress) {
         logger.warn(CONTEXT, 'Update check already in progress. Skipping.');
         return { inProgress: true, updated: 0, failed: 0, updatedIds: [] };
      }

      this._isUpdateInProgress = true;
      logger.debug(CONTEXT, 'Starting update check...');

      try {
         const allScripts = await agents.getAllMeta();
         const scriptsToCheck = allScripts.filter(
            ({ enabled, meta }) => enabled && (meta.updateURL || meta.downloadURL) && meta.version
         );

         if (!scriptsToCheck.length) {
            logger.debug(CONTEXT, 'No updatable scripts found.');
            return { updated: 0, failed: 0, updatedIds: [] };
         }

         const limit = createConcurrencyLimiter(CONCURRENT_LIMIT);
         const updateTasks = scriptsToCheck.map((script) => limit(() => this.checkSingleScript(script)));
         const results = await Promise.allSettled(updateTasks);

         const summary = results.reduce(
            (acc, { status, value, reason }) => {
               if (status === 'fulfilled' && value) {
                  acc.updated++;
                  acc.updatedIds.push(value);
               } else if (status === 'rejected') {
                  acc.failed++;
                  logger.error(CONTEXT, `A script update check failed: ${reason?.message ?? reason}`);
               }
               return acc;
            },
            { updated: 0, failed: 0, updatedIds: [] }
         );

         // Ensure CacheManager in SW RAM is refreshed after background auto-updates
         if (summary.updated > 0) {
            await CacheManager.refresh();
            logger.debug(CONTEXT, 'CacheManager RAM store refreshed following background update.');
         }

         logger.debug(CONTEXT, 'Update check finished.', summary);
         return summary;
      } finally {
         this._isUpdateInProgress = false;
         logger.debug(CONTEXT, 'Update check lock released.');
      }
   },

   /**
    * Checks a single script for updates and applies the upgrade atomically if a newer version exists.
    * @param {Object} script - Script metadata object.
    * @returns {Promise<number|null>} Script ID if updated, or null if no update occurred or check failed.
    */
   async checkSingleScript(script) {
      const { meta: currentMeta } = script;
      // Extract scalar string URLs
      const rawUpdateUrl = currentMeta.updateURL ?? currentMeta.downloadURL;
      const updateUrl = toScalarString(rawUpdateUrl);
      const scriptName = toScalarString(currentMeta.name);

      try {
         const { remoteMeta, remoteMetaCode } = await this._fetchAndParseRemoteMeta(updateUrl, currentMeta.name);

         if (!remoteMeta) {
            throw new Error('Remote update server returned invalid or empty metadata.');
         }

         // Use updateScriptProperties to safely merge state without overwriting missing userCode
         if (script.state?.lastUpdateError) {
            await ScriptRegistry.updateScriptProperties(script.id, {
               state: { ...script.state, lastUpdateError: null }
            });
         }

         if (compareSemanticVersions(currentMeta.version, remoteMeta.version) <= 0) {
            return null; // Remote version is equal or older
         }

         // Clear past update errors from database if metadata fetch succeeds
         if (script.state?.lastUpdateError) {
            const cleanState = { ...script.state };
            delete cleanState.lastUpdateError;
            await agents.put({ ...script, state: cleanState });
         }

         logger.debug(CONTEXT, `Found update for "${scriptName}": ${toScalarString(currentMeta.version)} -> ${toScalarString(remoteMeta.version)}`);

         const newCode = await this._fetchFullScriptCode({ currentMeta, remoteMeta, remoteMetaCode, updateUrl });
         const { meta: newMeta } = MetadataParser.parse(newCode);

         // Validate downloaded payload to prevent overwriting scripts with Captive Portal HTML or 404 pages
         if (!newMeta || !newMeta.name) {
            throw new Error('Downloaded update payload does not contain a valid userscript metadata block.');
         }

         // Prefetch new dependencies before persisting script update to preserve atomic integrity
         await this._prefetchNewDependencies(newMeta);

         const updatedScriptObject = {
            ...script,
            userCode: newCode,
            meta: newMeta, // Pass the newly parsed metadata to update the DB version and prevent infinite update loops
            state: {
               ...script.state,
               highlightUpdate: true,
               previousVersion: toScalarString(currentMeta.version), // Store previous version string for UI display
               lastUpdateError: null,
            },
         };

         const saveResult = await ScriptRegistry.createOrUpdateFromSource(updatedScriptObject);

         // Handle cases where the updated script requires new host permissions
         if (saveResult?.needsPermissions) {
            updatedScriptObject.enabled = false;
            updatedScriptObject.state.permissionError = true;
            await ScriptRegistry.createOrUpdateFromPrepared(updatedScriptObject);
            logger.warn(CONTEXT, `Script "${scriptName}" updated but disabled due to new permission requirements.`);
         }

         await cleanupObsoleteDependencies(script.id, currentMeta.require, newMeta.require);

         return script.id;

      } catch (err) {
         logger.warn(CONTEXT, `Update check failed for script "${scriptName}": ${err.message}`);

         // Safely update error state without causing Data Loss
         await ScriptRegistry.updateScriptProperties(script.id, {
            state: { ...script.state, lastUpdateError: err.message }
         });

         throw err; // Throw error so Promise.allSettled marks it as rejected and increments the failed counter
      }
   },

   /**
    * Fetches and parses script header metadata from remote URL.
    * @private
    * @param {string} url - Remote metadata URL.
    * @param {string} scriptName - Local script display name.
    * @returns {Promise<{remoteMeta?: Object, remoteMetaCode?: string}>}
    */
   async _fetchAndParseRemoteMeta(url, scriptName) {
      const response = await Utils.fetchWithTimeout(url, { allowedTypes: ALLOWED_SCRIPT_CONTENT_TYPES });
      const remoteMetaCode = await response.text();
      const { meta: remoteMeta } = MetadataParser.parse(remoteMetaCode);

      if (!remoteMeta || !remoteMeta.version || !remoteMeta.name) {
         throw new Error(`Remote metadata for "${scriptName}" is invalid or missing @version/@name.`);
      }
      return { remoteMeta, remoteMetaCode };
   },

   /**
    * Downloads full userscript source code, reusing remote metadata body if update and download URLs match.
    * @private
    * @returns {Promise<string>}
    */
   async _fetchFullScriptCode({ currentMeta, remoteMeta, remoteMetaCode, updateUrl }) {
      // Ensure all candidate download URLs are scalar strings
      let downloadUrl = toScalarString(remoteMeta.downloadURL ?? currentMeta.downloadURL ?? updateUrl); // Changed 'const' to 'let' to allow variable mutation
      // Automatically infer the .user.js payload URL from the .meta.js update URL.
      if (downloadUrl.endsWith('.meta.js')) {
         downloadUrl = downloadUrl.replace(/\.meta\.js$/, '.user.js');
      }

      return downloadUrl === updateUrl && !updateUrl.endsWith('.meta.js')
         ? remoteMetaCode
         : await Utils.fetchWithTimeout(downloadUrl, { allowedTypes: ALLOWED_SCRIPT_CONTENT_TYPES }).then((res) => res.text());
   },

   /**
    * Prefetches `@require` dependencies to ensure atomic script update.
    * @private
    * @param {Object} newMeta - Parsed remote metadata object.
    * @returns {Promise<void>}
    */
   async _prefetchNewDependencies(newMeta) {
      const newRequires = [newMeta.require].flat().filter(Boolean);
      if (!newRequires.length) return;

      logger.debug(CONTEXT, `Pre-fetching ${newRequires.length} @require URLs for "${toScalarString(newMeta.name)}"...`);
      try {
         // Pass forceBypassCache = true to guarantee fresh dependency downloads
         await Utils.fetchRequireCode(newRequires, true);
      } catch (err) {
         throw new Error(`Failed to pre-fetch @require dependencies: ${err.message}`);
      }
   },
};

export { compareSemanticVersions };
export default UpdateService;
