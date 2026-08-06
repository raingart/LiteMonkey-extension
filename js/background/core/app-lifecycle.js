import browser from '../../libs/browser-support.js';
import { logger } from '../../libs/logger.js';
import { DEFAULT_SETTINGS } from '../../constants.js';

const CONTEXT = 'AppLifecycle';

/**
 * Manages core extension lifecycle events like installation, updates, and browser startup.
 * Acts as the centralized point for initial configuration setup and database migrations.
 */
const AppLifecycle = {
   /**
    * Attaches runtime event listeners for browser startup and extension installation.
    */
   initialize() {
      browser.runtime.onInstalled.addListener((details) => this.onInstalled(details));
      browser.runtime.onStartup.addListener(() => this.onStartup());

      logger.debug(CONTEXT, 'Lifecycle event listeners initialized');
   },

   /**
    * Handles the `runtime.onInstalled` event firing on first install or extension updates.
    *
    * @param {browser.runtime.OnInstalledDetails} details Event details including installation reason and previous version.
    */
   async onInstalled(details) {
      const reason = details?.reason;
      logger.debug(CONTEXT, `onInstalled event triggered. Reason: ${reason}`);

      if (reason === 'install') {
         try {
            await browser.storage.sync.set({ extension_settings: DEFAULT_SETTINGS });
            logger.info(CONTEXT, 'Default configuration initialized successfully.');
         } catch (err) {
            logger.error(CONTEXT, 'Failed to initialize default settings:', err);
         }
         // TODO: Set default settings on first installation.
         // Example: browser.storage.sync.set({ someDefault: true });
         // TODO: Open a welcome page.
         // Example: browser.tabs.create({ url: 'html/welcome.html' });
      } else if (reason === 'update') {
         const previousVersion = details?.previousVersion ?? 'unknown';
         logger.debug(CONTEXT, `Extension updated from version ${previousVersion}.`);
         // TODO: Run data migrations if needed.
         // Example: if (details.previousVersion === '0.0.1') { migrateToV2(); }
      }
   },

   /**
    * Handles the `runtime.onStartup` event firing when the browser browser profile initializes.
    */
   onStartup() {
      logger.info(CONTEXT, 'Browser startup completed. Lite Monkey background service active.');
   },
};

export default AppLifecycle;
