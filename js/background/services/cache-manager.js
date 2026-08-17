import { agents } from '../../database.js';
import { logger } from '../../libs/logger.js';

const CONTEXT = 'CacheManager';

/**
 * In-memory cache for extension script objects.
 * Loads script entities once on startup to serve ultra-fast lookups without querying IndexedDB repeatedly.
 */
const CacheManager = {
   /**
    * Lookup map storing script ID to optimized script object.
    * @private
    * @type {Map<number, Object>}
    */
   _scriptMap: new Map(),

   /**
    * Guard flag ensuring initialization logic executes only once per lifecycle.
    * @private
    * @type {boolean}
    */
   _isInitialized: false,
   _initPromise: null, // Mutex promise to prevent Thundering Herd on startup


   /**
    * Initializes the cache on startup if not already initialized.
    * @returns {Promise<void>}
    */
   async initialize() {
      if (this._isInitialized) return;

      // If initialization is already in progress, await the existing promise
      if (!this._initPromise) {
         this._initPromise = this.refresh().then(() => {
            this._isInitialized = true;
            this._initPromise = null;
            logger.debug(CONTEXT, 'Initialized');
         }).catch((err) => {
            this._initPromise = null;
            throw err;
         });
      }
      return this._initPromise;
   },

   /**
    * Reloads all scripts from IndexedDB into memory and optimizes memory usage by script type.
    * Should be called after any write operation (add, edit, toggle, delete) in the script database.
    * @returns {Promise<void>}
    */
   async refresh() {
      try {
         const allScripts = await agents.getAllFullScripts();

         const optimizedScripts = (allScripts || []).filter(Boolean).map((script) => {
            if (script.type === 'userstyle') {
               // Retain full CSS code in RAM for userstyles to enable synchronous/instant injection and prevent Flash of Unstyled Content (FOUC).
               return script;
            } else {
               // Strip heavy JavaScript source code from Service Worker RAM to keep memory footprint minimal in Manifest V3; JS is fetched dynamically on demand.
               const { userCode, ...metadataOnly } = script;
               return metadataOnly;
            }
         });

         this._scriptMap = new Map(optimizedScripts.map((script) => [script.id, script]));
         logger.debug(CONTEXT, `Cache refreshed. Total scripts: ${this._scriptMap.size}`);
      } catch (err) {
         logger.error(CONTEXT, 'Failed to refresh cache:', err);
         // Keep the last successful map. Replacing it with [] makes injection and
         // GET_ALL_SCRIPTS look like a wipe even though IndexedDB is intact.
      }
   },

   /**
    * Returns all cached scripts as an array.
    * @returns {Promise<Array<Object>>} Array of cached script objects.
    */
   async get() {
      if (!this._isInitialized) await this.initialize();
      return [...this._scriptMap.values()];
   },

   /**
    * Returns a cached script entity by its numeric database ID.
    * @param {number} id - Numeric primary key ID of the script.
    * @returns {Promise<Object|undefined>} The cached script object or undefined if not found.
    */
   async getById(id) {
      if (!this._isInitialized) await this.initialize();
      const numericId = typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id) : id;
      return this._scriptMap.get(numericId);
   },
};

// WARNING: Exported as default export (`CacheManager`). Ensure consumer modules import using default import syntax.
export default CacheManager;
