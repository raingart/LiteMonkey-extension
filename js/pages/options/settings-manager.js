import browser from '../../libs/browser-support.js';
import { i18n } from '../../libs/localization.js';
import { logger } from '../../libs/logger.js';
import { MSG } from '../../message-types.js';
import { sendMessageWithRetry } from '../../libs/message-service.js';
import { DEFAULT_SETTINGS } from '../../constants.js';

const CONTEXT = 'SettingsManager';

/**
 * Manages reading, writing, and live updates for global extension settings.
 */
export class SettingsManager {
   #form;
   #saveBtn;
   #isDirty = false;
   #onSaveCallback;

   /**
    * @param {string} formSelector DOM selector for the settings form element
    */
   constructor(formSelector) {
      this.#form = document.querySelector(formSelector);
      if (!this.#form) {
         throw new Error(`SettingsManager: Element ${formSelector} not found.`);
      }
      this.#saveBtn = this.#form.querySelector('button[type="submit"]');
   }

   /**
    * Initializes settings manager by loading stored values and attaching form event listeners.
    * @param {Function} [onSaveCallback] Optional callback invoked after successful settings save.
    */
   async init(onSaveCallback) {
      this.#onSaveCallback = onSaveCallback;
      await this.load();
      this.#attachListeners();
   }

   /**
    * Reads settings from browser storage (sync & local) and populates form elements.
    */
   async load() {
      const [{ extension_settings }, { logLevel }] = await Promise.all([
         browser.storage.sync.get({ extension_settings: {} }),
         browser.storage.local.get({ logLevel: DEFAULT_SETTINGS.logLevel }),
      ]);

      const finalSettings = { ...DEFAULT_SETTINGS, ...extension_settings, logLevel };

      for (const key in finalSettings) {
         const element = this.#form.elements[key];
         if (element) {
            if (element.type === 'checkbox') {
               element.checked = !!finalSettings[key];
            } else {
               element.value = finalSettings[key];
            }
         }
      }
      this.#setDirty(false);
   }

   /**
    * Persists form settings into sync and local storage, notifying background processes.
    * @private
    */
   async #save() {
      this.#saveBtn.disabled = true;
      this.#saveBtn.textContent = i18n('opt_btn_save_settings_process');

      // Explicit mapping to partition syncable settings vs device-local settings
      const SETTINGS_MAP = {
         autoUpdateIntervalDays: 'sync',
         showBadgeCount: 'sync',
         badgeColor: 'sync',
         muteAllLogs: 'sync',
         editorMode: 'sync',
         theme: 'sync',
         preferredLightTheme: 'sync',
         preferredDarkTheme: 'sync',
         logLevel: 'local',
      };

      const syncSettings = {};
      const localSettings = {};

      for (const element of this.#form.elements) {
         if (!element.name || !SETTINGS_MAP[element.name]) continue;
         const storageArea = SETTINGS_MAP[element.name];
         const target = storageArea === 'sync' ? syncSettings : localSettings;
         target[element.name] = element.type === 'checkbox' ? element.checked : element.value;
      }

      syncSettings.autoUpdateIntervalDays = parseInt(syncSettings.autoUpdateIntervalDays, 10);
      localSettings.logLevel = parseInt(localSettings.logLevel, 10);

      try {
         await Promise.all([
            browser.storage.sync.set({ extension_settings: syncSettings }),
            browser.storage.local.set(localSettings),
         ]);
         await sendMessageWithRetry({ type: MSG.SETTINGS_UPDATED });
         this.#setDirty(false);

         this.#onSaveCallback?.();
      } catch (err) {
         logger.error(CONTEXT, 'Failed to save settings', err);
      } finally {
         this.#saveBtn.disabled = false;
         this.#saveBtn.textContent = i18n('opt_btn_save_settings');
      }
   }

   /**
    * Sets form unsaved state and toggles visual indicator class.
    * @private
    * @param {boolean} isDirty
    */
   #setDirty(isDirty) {
      this.#saveBtn.classList.toggle('unsaved', isDirty);
      this.#isDirty = isDirty;
   }

   get isDirty() {
      return this.#isDirty;
   }

   /**
    * Binds form submission, input change events, and beforeunload handlers.
    * @private
    */
   #attachListeners() {
      this.#form.addEventListener('submit', (e) => {
         e.preventDefault();
         this.#save();
      });

      this.#form.addEventListener('input', ({ target }) => {
         this.#setDirty(true);
         const detail = {};
         let eventName = '';

         if (target.name === 'muteAllLogs') {
            eventName = 'globalSettingsChanged';
            detail.muteAllLogs = target.checked;
         } else if (target.name === 'theme') {
            eventName = 'themeChanged';
            detail.theme = target.value;
         }

         if (eventName) {
            this.#form.dispatchEvent(new CustomEvent(eventName, { bubbles: true, detail }));
         }
      });
   }
}
