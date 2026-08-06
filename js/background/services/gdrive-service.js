import browser from '../../libs/browser-support.js';
import { agents } from '../../database.js';
import { logger } from '../../libs/logger.js';

const CONTEXT = 'GDriveService';
const manifest = browser.runtime.getManifest();
const CLIENT_ID = manifest.oauth2?.client_id;

/**
 * Service managing Google Drive appDataFolder synchronization for scripts and GM_storage.
 * Uses isolated `appDataFolder` scope to prevent accessing or requesting access to full user drive contents.
 */
class GDriveServiceImpl {
   /**
    * Cached OAuth2 access token.
    * @private
    * @type {string|null}
    */
   #authToken = null;
   #tokenPromise = null; // Added token promise mutex to avoid duplicate auth popups


   /**
    * Obtains an OAuth2 access token for Google APIs across Chrome and Firefox extension runtimes.
    * @param {boolean} [interactive=false] - Whether to prompt the user for interactive consent if token is missing.
    * @returns {Promise<string>} OAuth2 access token.
    */
   async getAuthToken(interactive = false) {
      logger.debug(CONTEXT, `getAuthToken called. Interactive: ${interactive}`);

      if (this.#authToken) return this.#authToken;

      if (this.#tokenPromise) return this.#tokenPromise;

      this.#tokenPromise = (async () => {
         try {
            // Chrome extension runtime: Use native chrome.identity API
            if (typeof chrome !== 'undefined' && chrome.identity?.getAuthToken) {
               return await new Promise((resolve, reject) => {
                  chrome.identity.getAuthToken({ interactive }, (token) => {
                     if (chrome.runtime.lastError) {
                        logger.error(CONTEXT, `Chrome identity.getAuthToken failed: ${chrome.runtime.lastError.message}`);
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                     }
                     this.#authToken = token;
                     logger.debug(CONTEXT, 'OAuth2 token obtained successfully (Chrome).');
                     resolve(token);
                  });
               });
            }

            // Firefox WebExtensions runtime: Fallback to launchWebAuthFlow against Google OAuth2 authorization endpoints
            if (typeof browser !== 'undefined' && browser.identity?.launchWebAuthFlow) {
               logger.debug(CONTEXT, 'Starting launchWebAuthFlow for Firefox...');
               const redirectUrl = browser.identity.getRedirectURL();
               const authUrl =
                  'https://accounts.google.com/o/oauth2/v2/auth' +
                  `?client_id=${CLIENT_ID}` +
                  `&response_type=token` +
                  `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
                  `&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.appdata')}`;

               const responseUrl = await browser.identity.launchWebAuthFlow({
                  url: authUrl,
                  interactive,
               });

               const tokenMatch = responseUrl.match(/access_token=([^&]+)/);
               if (!tokenMatch) {
                  logger.error(CONTEXT, 'Firefox launchWebAuthFlow failed to extract access token.');
                  throw new Error('Auth token not found in Google response redirect.');
               }

               this.#authToken = tokenMatch[1];
               logger.debug(CONTEXT, 'OAuth2 token obtained successfully (Firefox).');
               return this.#authToken;
            }

            throw new Error('Identity API is not supported in this environment.');
         } finally {
            this.#tokenPromise = null; // Release promise mutex
         }
      })();

      return this.#tokenPromise;
   }

   /**
    * Private wrapper over `fetch` injecting Bearer authorization headers and handling 401 token eviction.
    * @private
    * @param {string} url - Target Google API endpoint URL.
    * @param {RequestInit} [options={}] - Standard fetch configuration object.
    * @param {boolean} [interactive=false] - Interactive flag passed to token getter.
    * @returns {Promise<Response>} Fetch Response object.
    */
   /**
    * Private wrapper over `fetch` injecting Bearer authorization headers with automatic 401 retry.
    * @private
    */
   async #fetchAPI(url, options = {}, interactive = false, isRetry = false) {
      const token = await this.getAuthToken(interactive);
      const method = options.method || 'GET';

      logger.debug(CONTEXT, `Sending request: ${method} ${url.split('?')[0]}`);

      // Content-Type is placed first so custom headers in options.headers (e.g. multipart/related) can override it
      const headers = {
         'Content-Type': 'application/json',
         ...options.headers,
         Authorization: `Bearer ${token}`,
      };

      const response = await fetch(url, {
         ...options,
         cache: 'no-store',
         headers,
      });

      logger.debug(CONTEXT, `Response received: ${method} ${url.split('?')[0]} -> Status: ${response.status}`);

      // Transparent single-retry on 401 Unauthorized to acquire fresh OAuth token without user error
      if (response.status === 401 && !isRetry) {
         logger.warn(CONTEXT, 'Unauthorized (401). Invalidating token and executing single retry...');
         if (typeof chrome !== 'undefined' && chrome.identity?.removeCachedAuthToken) {
            await new Promise((resolve) => { // Await removal of cached OAuth token before executing retry
               chrome.identity.removeCachedAuthToken({ token: this.#authToken }, () => {
                  this.#authToken = null;
                  resolve();
               });
            });
         } else {
            this.#authToken = null;
         }
         // Retry request once with fresh token request
         return this.#fetchAPI(url, options, interactive, true);
      }

      return response;
   }

   /**
    * Scans Google Drive appDataFolder and returns a map of script sync statuses compared to local database.
    * @param {boolean} [interactive=false] - Whether to trigger interactive OAuth authentication if unauthenticated.
    * @returns {Promise<Map<string|number, Object>>} Map of script IDs/UUIDs to sync status descriptors.
    */
   async getSyncStatuses(interactive = false) {
      logger.debug(CONTEXT, `getSyncStatuses started inside appDataFolder. Interactive: ${interactive}`);

      // Gracefully exit if optional 'identity' permission is absent to prevent authorization errors
      try {
         const hasPermission = await browser.permissions.contains({ permissions: ['identity'] });
         if (!hasPermission) {
            logger.debug(CONTEXT, 'Google Drive sync is not configured (missing "identity" permission). Skipping status check.');
            return new Map();
         }
      } catch (e) {
         logger.warn(CONTEXT, 'Failed to check "identity" permission state:', e);
         return new Map();
      }

      const statusMap = new Map();
      try {
         // Query files restricted strictly to hidden isolated appDataFolder scope
         const listUrl = 'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,description)';

         const listRes = await this.#fetchAPI(listUrl, {}, interactive);
         if (!listRes.ok) {
            const errorData = await listRes.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `Google Drive API request failed with status ${listRes.status}`);
         }

         const { files = [] } = await listRes.json();
         logger.debug(CONTEXT, `GDrive scan completed. Found ${files.length} files in folder.`);

         const localMetaList = await agents.getAllMeta();
         const localMap = new Map(localMetaList.map((s) => [s.uuid, s]));
         logger.debug(CONTEXT, `Local database scan completed. Found ${localMetaList.length} scripts.`);

         for (const cloudFile of files) {
            const uuidMatch = cloudFile.name.match(/^script_(.+)\.json$/);
            if (!uuidMatch) {
               logger.warn(CONTEXT, `Skipping unrecognized file in sync folder: "${cloudFile.name}"`);
               continue;
            }

            const uuid = uuidMatch[1];
            const localScript = localMap.get(uuid);

            let cloudUpdatedAt = 0;
            let cloudName = '';
            let cloudVersion = '';
            try {
               const descData = JSON.parse(cloudFile.description || '{}');
               cloudUpdatedAt = descData.updatedAt || 0;
               cloudName = descData.name || '';
               cloudVersion = descData.version || '';
            } catch {
               logger.warn(CONTEXT, `Failed to parse description metadata for file: ${cloudFile.name}`);
            }

            if (!localScript) {
               statusMap.set(uuid, {
                  status: 'cloud_only',
                  cloudFileId: cloudFile.id,
                  name: cloudName,
                  version: cloudVersion,
               });
            } else {
               const diff = localScript.updatedAt - cloudUpdatedAt;
               logger.debug(CONTEXT, `Comparing "${localScript.meta.name}": Local: ${localScript.updatedAt}, Cloud: ${cloudUpdatedAt}, Diff: ${diff}ms`);

               // A 2000ms threshold buffer accommodates network transport delay and cross-device clock skew
               if (Math.abs(diff) < 2000) {
                  statusMap.set(localScript.id, { status: 'synced', cloudFileId: cloudFile.id });
               } else if (diff > 0) {
                  statusMap.set(localScript.id, { status: 'local_newer', cloudFileId: cloudFile.id });
               } else {
                  statusMap.set(localScript.id, { status: 'cloud_newer', cloudFileId: cloudFile.id });
               }
               localMap.delete(uuid);
            }
         }

         for (const [uuid, localScript] of localMap) {
            logger.debug(CONTEXT, `Script exists only locally: "${localScript.meta.name}"`);
            statusMap.set(localScript.id, { status: 'not_synced' });
         }

         logger.info(CONTEXT, 'Sync status mapping completed successfully.', Object.fromEntries(statusMap));
      } catch (err) {
         // Silently catch background status check errors (e.g. unconfigured OAuth or offline) if non-interactive
         if (!interactive) {
            logger.debug(CONTEXT, 'Google Drive background status check skipped (unauthenticated or unconfigured OAuth):', err.message);
            return new Map();
         }
         logger.error(CONTEXT, 'Failed to fetch GDrive sync statuses:', err);
         throw err;
      }
      return statusMap;
   }

   /**
    * Uploads a local script entity along with its GM_storage settings to Google Drive appDataFolder.
    * @param {number} scriptId - Primary database key of local script.
    * @returns {Promise<string>} Google Drive file ID.
    */
   async uploadScript(scriptId) {
      logger.debug(CONTEXT, `uploadScript initiated for script ID: ${scriptId}`);
      const script = await agents.getFullScript(scriptId);
      if (!script) throw new Error('Script not found');

      // Repair missing UUID dynamically and persist to local IndexedDB
      if (!script.uuid) {
         script.uuid = crypto.randomUUID();
         await agents.put(script);
         logger.info(CONTEXT, `Generated missing UUID for script ${scriptId}: ${script.uuid}`);
      }

      const filename = `script_${script.uuid}.json`;

      const isSyncStorageEnabled = script.config?.syncStorage ?? true;
      let storage = {};

      if (isSyncStorageEnabled) {
         const keys = await agents.listSettings(scriptId);
         const storageEntries = await Promise.all(
            keys.map(async (key) => [key, await agents.getSetting(scriptId, key)])
         );
         storage = Object.fromEntries(storageEntries);
         logger.debug(CONTEXT, `Packed ${keys.length} GM_storage keys for upload.`);
      } else {
         logger.debug(CONTEXT, 'GM_storage upload is disabled by user config. Skipping.');
      }

      logger.debug(CONTEXT, `Checking if file "${filename}" already exists in cloud...`);
      const q = `name='${filename}' and trashed=false`;
      const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&spaces=appDataFolder&fields=files(id)`;
      const searchRes = await this.#fetchAPI(searchUrl);
      const { files = [] } = await searchRes.json();
      const existingFileId = files[0]?.id;

      // Sanitize name in metadata description
      const safeName = String(script.meta?.name || 'Untitled').slice(0, 100);
      const metadata = {
         name: filename,
         description: JSON.stringify({
            updatedAt: script.updatedAt,
            name: safeName,
            version: String(script.meta?.version || '1.0'),
         }),
         parents: existingFileId ? undefined : ['appDataFolder'],
      };

      const fileData = {
         uuid: script.uuid,
         enabled: script.enabled,
         type: script.type,
         userCode: script.userCode,
         meta: script.meta,
         config: script.config,
         storage,
      };

      const boundary = '-------LiteMonkeyBoundary' + crypto.randomUUID().replace(/-/g, '');
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const multipartBody =
         `--${boundary}\r\n` +
         'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
         JSON.stringify(metadata) +
         delimiter +
         'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
         JSON.stringify(fileData) +
         closeDelimiter;

      const url = existingFileId
         ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
         : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

      const method = existingFileId ? 'PATCH' : 'POST';

      logger.debug(CONTEXT, `Uploading payload. File ID in cloud: ${existingFileId || 'New file'}, URL: ${url}`);

      const res = await this.#fetchAPI(url, {
         method,
         headers: {
            'Content-Type': `multipart/related; boundary=${boundary}`,
         },
         body: multipartBody,
      });

      if (!res.ok) {
         const errText = await res.text();
         logger.error(CONTEXT, `GDrive appDataFolder upload failed. Status: ${res.status}, Response: ${errText}`);
         throw new Error(`GDrive upload failed with status ${res.status}`);
      }

      const responseData = await res.json();
      logger.info(CONTEXT, `Successfully uploaded script ${scriptId} to GDrive appDataFolder. File ID: ${responseData.id}`);
      return responseData.id;
   }

   /**
    * Downloads a script payload from Google Drive appDataFolder and synchronizes it into local database.
    * @param {string} cloudFileId - Google Drive file ID.
    * @returns {Promise<void>}
    */
   async downloadScript(cloudFileId) {
      const url = `https://www.googleapis.com/drive/v3/files/${cloudFileId}?alt=media`;
      const res = await this.#fetchAPI(url);
      if (!res.ok) throw new Error('Failed to download script from GDrive');

      const cloudData = await res.json();

      // Validate structural integrity of cloud payload before persisting to IndexedDB
      if (!cloudData || typeof cloudData !== 'object' || !cloudData.uuid || typeof cloudData.userCode !== 'string') {
         throw new Error('Downloaded Google Drive file contains an invalid or corrupted script payload.');
      }

      const allLocal = await agents.getAllFullScripts();
      const localAnalogue = allLocal.find((s) => s.uuid === cloudData.uuid);

      const metaUrl = `https://www.googleapis.com/drive/v3/files/${cloudFileId}?fields=description`;
      const metaRes = await this.#fetchAPI(metaUrl);
      const { description, modifiedTime } = await metaRes.json();

      let cloudUpdatedAt = 0;
      try {
         cloudUpdatedAt = JSON.parse(description || '{}').updatedAt;
      } catch { }

      // Fallback to Google Drive system modifiedTime if description payload lacks updatedAt
      if (!cloudUpdatedAt && modifiedTime) {
         cloudUpdatedAt = new Date(modifiedTime).getTime();
      }

      const scriptToSave = {
         id: localAnalogue?.id,
         uuid: cloudData.uuid,
         enabled: cloudData.enabled,
         type: cloudData.type,
         userCode: cloudData.userCode,
         meta: cloudData.meta,
         config: cloudData.config,
         state: cloudData.state || {},
         updatedAt: cloudUpdatedAt || cloudData.updatedAt || Date.now(),
      };

      const permResult = await Utils.handlePermissionCheck(scriptToSave);
      if (permResult && scriptToSave.enabled) {
         scriptToSave.enabled = false;
         scriptToSave.state.permissionError = true;
         if (permResult.unrequestable) {
            scriptToSave.state.registrationError = permResult.error;
         }
         logger.warn(CONTEXT, `Script ${scriptToSave.uuid} downloaded but disabled due to missing permissions.`);
      }

      // Save or update script entity in local IndexedDB
      const savedId = await agents.put(scriptToSave);

      // Re-read updated configuration to check local storage sync setting
      const freshScript = await agents.getMeta(savedId);
      const isSyncStorageEnabled = freshScript?.config?.syncStorage ?? true;

      // Restore GM_storage values from cloud payload if user configuration allows
      if (isSyncStorageEnabled && cloudData.storage && typeof cloudData.storage === 'object') {
         logger.debug(CONTEXT, `Restoring ${Object.keys(cloudData.storage).length} GM_storage keys for script: ${savedId}`);
         await agents.setFullStorage(savedId, cloudData.storage);
      } else {
         logger.debug(CONTEXT, 'GM_storage download/restore is disabled or empty. Local settings preserved.');
      }

      logger.info(CONTEXT, `Successfully downloaded and synchronized script: ${cloudData.uuid}`);
   }

   /**
    * Deletes a specific backup file from Google Drive.
    * @param {string} cloudFileId - Google Drive file ID.
    * @returns {Promise<void>}
    */
   async deleteCloudFile(cloudFileId) {
      logger.debug(CONTEXT, `deleteCloudFile initiated for cloud file ID: ${cloudFileId}`);
      const url = `https://www.googleapis.com/drive/v3/files/${cloudFileId}`;
      const res = await this.#fetchAPI(url, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete script from GDrive');
      logger.info(CONTEXT, `Successfully deleted cloud file: ${cloudFileId}`);
   }

   /**
    * Clears all backup files residing inside Google Drive appDataFolder.
    * @returns {Promise<void>}
    */
   async deleteSyncFolder() {
      logger.debug(CONTEXT, 'deleteSyncFolder (clear appDataFolder) initiated...');
      try {
         const listUrl = 'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id)';
         const listRes = await this.#fetchAPI(listUrl);
         const { files = [] } = await listRes.json();

         logger.debug(CONTEXT, `Found ${files.length} files to delete in appDataFolder.`);

         for (const f of files) {
            await this.deleteCloudFile(f.id).catch((err) => {
               logger.warn(CONTEXT, `Failed to delete individual cloud file ${f.id}:`, err);
            });
         }

         logger.info(CONTEXT, 'Successfully cleared all sync files from GDrive appDataFolder.');
      } catch (err) {
         logger.error(CONTEXT, 'Failed to clear files in appDataFolder:', err);
         throw err;
      }
   }
}

// WARNING: Exported as a default singleton instance (`GDriveService`). Maintain default import syntax in consumers.
const GDriveService = new GDriveServiceImpl();
export default GDriveService;
