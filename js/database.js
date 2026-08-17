import Dexie from './libs/dexie.min.mjs';
import { logger } from './libs/logger.js';
import { normalizeCustomUrlsExcludes } from './libs/origin-guard.js';
import { MAX_STORAGE_VALUE_SIZE_BYTES, MAX_STORAGE_KEYS_PER_SCRIPT } from './constants.js';

const CONTEXT = 'Database';
const DB_NAME = 'LiteMonkeyDB';
const DB_SCHEMA_VERSION = 1;

export const db = new Dexie(DB_NAME);

/**
 * Dexie Schema Configuration
 * Note: Source code (`scriptCodes`) is intentionally isolated in a dedicated store from metadata (`scripts`).
 * Storing large script strings inside IndexedDB indexes degrades query and iteration performance on script listings.
 */
db.version(DB_SCHEMA_VERSION).stores({
   scripts: '++id, &uuid, createdAt, updatedAt, enabled, position, type',
   scriptCodes: '&uuid',
   scriptStorage: '[uuid+key], uuid',
});

/**
 * Repository for script-related database operations.
 * Encapsulates Dexie IndexedDB interactions for consistent access and normalization.
 */
class ScriptRepository {
   /**
    * Coerces candidate ID inputs into clean numeric primary key integers
    * @private
    * @param {number|string} id
    * @returns {number|string}
    */
   #cleanId(id) {
      if (typeof id === 'string' && /^\d+$/.test(id.trim())) {
         return Number(id);
      }
      return id;
   }

   /**
    * Retrieves all script metadata records, sorted by display position.
    * @returns {Promise<Array<Object>>}
    */
   getAllMeta() {
      logger.debug(CONTEXT, 'Fetching all script metadata...');
      return db.scripts.orderBy('position').toArray();
   }

   /**
    * Retrieves the code record for a single script by its UUID.
    * @param {string} uuid - Unique script identifier.
    * @returns {Promise<Object|undefined>}
    */
   getCode(uuid) {
      logger.debug(CONTEXT, `Fetching script code for uuid: ${uuid}`);
      return db.scriptCodes.get(uuid);
   }

   /**
    * Retrieves all scripts hydrated with their corresponding user source code.
    * Primarily used for database exports and bulk synchronization.
    * @returns {Promise<Array<Object>>}
    */
   async getAllFullScripts() {
      logger.debug(CONTEXT, 'Fetching all scripts with code...');
      const [scripts, codes] = await Promise.all([
         db.scripts.orderBy('position').toArray(),
         db.scriptCodes.toArray(),
      ]);
      const codeMap = new Map(codes.map((c) => [c.uuid, c.userCode]));
      return scripts.map((script) => ({
         ...script,
         userCode: codeMap.get(script.uuid) ?? '',
      }));
   }

   /**
    * Retrieves a single script's metadata by auto-incrementing ID.
    * @param {number} id - Script database ID.
    * @returns {Promise<Object|undefined>}
    */
   getMeta(id) {
      const cleanId = this.#cleanId(id); // Coerce string ID
      logger.debug(CONTEXT, `Fetching script metadata for id: ${cleanId}`);
      return db.scripts.get(cleanId);
   }

   /**
    * Retrieves a single full script object (metadata + source code) by ID.
    * @param {number} id - Script database ID.
    * @returns {Promise<Object|undefined>}
    */
   async getFullScript(id) {
      const cleanId = this.#cleanId(id); // Coerce string ID
      logger.debug(CONTEXT, `Fetching script with code for id: ${cleanId}`);
      const script = await db.scripts.get(cleanId);
      if (!script) return undefined;

      const scriptCode = await db.scriptCodes.get(script.uuid);
      return { ...script, userCode: scriptCode?.userCode ?? '' };
   }

   /**
    * Adds or updates a script. Splits metadata and user source code into separate tables
    * within an atomic transaction to ensure store consistency.
    * @param {Object} fullScript - Script object containing metadata and userCode.
    * @returns {Promise<number>} The script's auto-incrementing primary ID.
    */
   async put(fullScript) {
      const { userCode, ...normalizedMeta } = this.#normalize(fullScript);

      logger.debug(CONTEXT, `Putting script: ${normalizedMeta.id ?? '(new)'}`);

      return db.transaction('rw', db.scripts, db.scriptCodes, async () => {
         await db.scriptCodes.put({ uuid: normalizedMeta.uuid, userCode });
         return db.scripts.put(normalizedMeta);
      });
   }

   /**
    * Efficiently adds or updates multiple script objects in a single transaction.
    * @param {Array<Object>} fullScripts - Array of full script objects.
    * @returns {Promise<void>}
    */
   async bulkPut(fullScripts) {
      logger.debug(CONTEXT, `Bulk putting ${fullScripts.length} scripts.`);

      const normalized = fullScripts.map((s) => this.#normalize(s));

      return db.transaction('rw', db.scripts, db.scriptCodes, async () => {
         // Resolve existing IDs by UUID to prevent ConstraintError on unique index during backup imports
         const uuids = normalized.map(s => s.uuid);
         const existingScripts = await db.scripts.where('uuid').anyOf(uuids).toArray();
         const uuidToIdMap = new Map(existingScripts.map(s => [s.uuid, s.id]));

         normalized.forEach(s => {
            if (uuidToIdMap.has(s.uuid)) {
               s.id = uuidToIdMap.get(s.uuid); // Force update instead of insert
            }
         });

         const metas = normalized.map(({ userCode, ...meta }) => meta);
         const codes = normalized.map(({ uuid, userCode }) => ({ uuid, userCode }));

         await db.scriptCodes.bulkPut(codes);
         await db.scripts.bulkPut(metas);
      });
   }


   /**
    * Deletes a script and all associated source code and storage values across all tables.
    * @param {number} id - The ID of the script to delete.
    * @returns {Promise<void>}
    */
   async delete(id) {
      const cleanId = this.#cleanId(id);
      logger.info(CONTEXT, `Deleting script with id: ${cleanId}`);
      const script = await db.scripts.get(cleanId);
      if (script) {
         return db.transaction('rw', db.scripts, db.scriptCodes, db.scriptStorage, async () => {
            await db.scriptStorage.where('uuid').equals(script.uuid).delete();
            await db.scriptCodes.delete(script.uuid);
            await db.scripts.delete(cleanId);
         });
      }
   }

   /**
    * Lists all GM storage keys for a script.
    * @param {number} scriptId - Database ID of the script.
    * @returns {Promise<string[]>} Array of key names.
    */
   async listSettings(scriptId) {
      const cleanId = this.#cleanId(scriptId);
      const script = await this.getMeta(cleanId);
      if (!script) {
         logger.warn(CONTEXT, `listSettings: Script with id ${cleanId} not found.`);
         return [];
      }
      // Dexie returns array of compound keys [[uuid, key1], [uuid, key2]]; extract key name at index 1
      const keys = await db.scriptStorage.where('uuid').equals(script.uuid).primaryKeys();
      return keys.map((compoundKey) => compoundKey[1]);
   }

   /**
    * Retrieves a GM storage value for a given script key.
    * @param {number} scriptId - Database ID of the script.
    * @param {string} key - Storage key name.
    * @param {*} [defaultValue] - Fallback returned if key does not exist.
    * @returns {Promise<*>} Stored value or default fallback.
    */
   async getSetting(scriptId, key, defaultValue) {
      const cleanId = this.#cleanId(scriptId);
      const script = await this.getMeta(cleanId);
      if (!script) return defaultValue;
      const storageItem = await db.scriptStorage.get([script.uuid, key]);
      return storageItem?.value ?? defaultValue;
   }

   /**
    * Stores a GM storage key-value pair for a script.
    * @param {number} scriptId - Database ID of the script.
    * @param {string} key - Storage key name.
    * @param {*} value - Value to persist.
    * @returns {Promise<void>}
    */
   async setSetting(scriptId, key, value) {
      const cleanId = this.#cleanId(scriptId);
      logger.debug(CONTEXT, `Setting key "${key}" for script ${cleanId}.`);
      const script = await this.getMeta(cleanId);
      if (script) {
         await db.scriptStorage.put({ uuid: script.uuid, key, value });
      } else {
         logger.warn(CONTEXT, `setSetting: Script ${cleanId} not found.`);
      }
   }

   /**
    * Deletes a specific GM storage key for a script.
    * @param {number} scriptId - Database ID of the script.
    * @param {string} key - Storage key name to remove.
    * @returns {Promise<void>}
    */
   async deleteSetting(scriptId, key) {
      const cleanId = this.#cleanId(scriptId);
      logger.debug(CONTEXT, `Deleting key "${key}" for script ${cleanId}.`);
      const script = await this.getMeta(cleanId);
      if (script) {
         await db.scriptStorage.delete([script.uuid, key]);
      }
   }

   /**
    * Replaces the entire GM storage object for a script inside a single transaction.
    * @param {number} scriptId - Database ID of the script.
    * @param {Record<string, *>} storageObject - Dictionary of key-value pairs.
    * @returns {Promise<void>}
    */
   async setFullStorage(scriptId, storageObject) {
      const cleanId = this.#cleanId(scriptId);
      const script = await this.getMeta(cleanId);
      if (!script) throw new Error(`Script with ID ${cleanId} not found.`);

      const entries = Object.entries(storageObject || {});
      if (entries.length > MAX_STORAGE_KEYS_PER_SCRIPT) {
         throw new Error(`Script has reached the storage limit of ${MAX_STORAGE_KEYS_PER_SCRIPT} keys.`);
      }

      const encoder = new TextEncoder();
      for (const [key, value] of entries) {
         const valueSize = encoder.encode(JSON.stringify(value)).length;
         if (valueSize > MAX_STORAGE_VALUE_SIZE_BYTES) {
            throw new Error(`Value for key "${key}" exceeds the ${MAX_STORAGE_VALUE_SIZE_BYTES / 1024 / 1024}MB size limit.`);
         }
      }

      const newValues = entries.map(([key, value]) => ({
         uuid: script.uuid,
         key,
         value,
      }));

      return db.transaction('rw', db.scriptStorage, async () => {
         await db.scriptStorage.where('uuid').equals(script.uuid).delete();
         if (newValues.length > 0) {
            await db.scriptStorage.bulkPut(newValues);
         }
      });
   }

   /**
    * Updates only the position field for a batch of scripts to prevent data loss.
    * @param {Array<{id: number, position: number}>} updates
    * @returns {Promise<void>}
    */
   async updatePositions(updates) {
      logger.debug(CONTEXT, `Updating positions for ${updates.length} scripts.`);
      return db.transaction('rw', db.scripts, async () => {
         await Promise.all(
            updates.map(u => db.scripts.update(u.id, { position: u.position }))
         );
      });
   }

   /**
    * Ensures a script entity adheres to the schema shape with safe defaults.
    * Recalculates script byte size accurately for multi-byte Unicode/UTF-8 source code.
    * @param {Object} [script={}] - Raw script object.
    * @returns {Object} Normalized script metadata with `userCode`.
    * @private
    */
   #normalize(script = {}) {
      const now = Date.now();

      // Extract known top-level properties and collect unhandled keys via rest parameters
      const {
         id,
         uuid = crypto.randomUUID(),
         enabled = true,
         position = now,
         type = 'userscript',
         createdAt = now,
         updatedAt = now,
         customUrls = null,
         sourceUrl = null,
         meta = {},
         config = {},
         state = {},
         userCode = '',
         iconDataUrl = null,
         ...rest
      } = script;

      const cleanId = this.#cleanId(id);
      const safeUuid = uuid || crypto.randomUUID();

      const normalized = {
         id: cleanId,
         uuid: safeUuid,
         enabled,
         position,
         type,
         createdAt,
         updatedAt,
         customUrls: typeof customUrls === 'string' ? normalizeCustomUrlsExcludes(customUrls) : customUrls,
         sourceUrl,

         // Calculate byte size using Blob to handle UTF-8 / multi-byte character strings accurately
         size: new Blob([userCode]).size,

         iconDataUrl,
         meta,
         config: {
            muteLogs: config.muteLogs ?? false,
            syncStorage: config.syncStorage ?? true,
         },
         state: {
            permissionError: state.permissionError ?? false,
            registrationError: state.registrationError ?? null,
            highlightUpdate: state.highlightUpdate ?? false,
            previousVersion: state.previousVersion ?? null,
         },
      };

      // Strip primary key if null/undefined so Dexie correctly applies key auto-incrementation
      if (normalized.id === undefined || normalized.id === null) {
         delete normalized.id;
      }

      return { ...normalized, userCode };
   }
}

// WARNING: Public instance exported as 'agents'. Maintain this exact export name across the extension.
export const agents = new ScriptRepository();
