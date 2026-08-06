import browser from './libs/browser-support.js';

/**
 * @module ThemeManager
 * @description Manages extension UI theme states ('light', 'dark', 'dark-gray', 'auto')
 * across pages (Popup, Options, Editor). Syncs theme settings via extension storage and
 * responds dynamically to operating system color scheme changes (`prefers-color-scheme`).
 */

const SETTINGS_KEY = 'extension_settings';
const DEFAULT_THEME_MODE = 'auto';
const DEFAULT_DARK_THEME = 'dark-gray';
const DEFAULT_LIGHT_THEME = 'light';
const CACHE_KEY = 'lite_monkey_cached_theme';

// Apply cached theme synchronously before waiting for async storage.sync API to prevent FOUC
try {
   const cachedTheme = localStorage.getItem(CACHE_KEY);
   if (cachedTheme && document.documentElement) {
      document.documentElement.dataset.theme = cachedTheme;
   } else if (document.documentElement) {
      const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
      document.documentElement.dataset.theme = prefersDark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
   }
} catch { }

/**
 * Resolves active UI theme state and applies dataset attributes to the HTML root element.
 */
export class ThemeManager {
   #settingsKey = SETTINGS_KEY;
   #mediaQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
   #settings = {};

   /**
    * Initializes the manager by reading persisted sync settings, applying
    * the active theme, and registering storage and system preference event listeners.
    *
    * @returns {Promise<void>}
    */
   async init() {
      try {
         const data = await browser?.storage?.sync?.get(this.#settingsKey);
         this.#settings = data?.[this.#settingsKey] ?? {};
      } catch (error) {
         console.error('[ThemeManager] Failed to load settings from storage:', error);
      }

      this.#applyTheme();
      this.#listenForStorageChanges();
      this.#listenForSystemThemeChanges();
   }

   /**
    * Determines which theme identifier string to apply based on settings and OS preference.
    *
    * @private
    * @returns {string} The active theme string (e.g. 'light', 'dark-gray').
    */
   #getThemeToApply = () => {
      const { theme = DEFAULT_THEME_MODE } = this.#settings;

      if (theme !== 'auto') return theme;

      // In 'auto' mode, fall back to default dark or light theme based on OS media match
      return this.#mediaQuery?.matches ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
   };

   /**
    * Applies the computed theme identifier to the document root element.
    * CSS stylesheets target `html[data-theme="..."]` selectors to activate theme rules.
    *
    * @private
    */
   #applyTheme = () => {
      if (document.documentElement) {
         const themeToApply = this.#getThemeToApply();
         document.documentElement.dataset.theme = themeToApply;
         // Persist applied theme synchronously to localStorage for zero-latency initial rendering
         try { localStorage.setItem(CACHE_KEY, themeToApply); } catch { }
      }
   };

   /**
    * Listens for setting updates in browser sync storage and updates theme if changed.
    *
    * @private
    */
   #listenForStorageChanges = () => {
      try {
         browser?.storage?.onChanged?.addListener((changes, areaName) => {
            if (areaName !== 'sync' || !changes[this.#settingsKey]) return;

            const change = changes[this.#settingsKey];
            if (!change) return;

            const newValue = change.newValue || {};
            const oldValue = change.oldValue || {};

            // Re-apply theme only when the 'theme' field itself changes
            if (newValue.theme !== oldValue.theme) {
               this.#settings = newValue;
               this.#applyTheme();
            }
         });
      } catch (error) {
         console.warn('[ThemeManager] Failed to attach storage change listener:', error);
      }
   };

   /**
    * Event handler triggered when operating system color scheme preference changes.
    *
    * @private
    */
   #handleSystemThemeChange = () => {
      // Only react to OS scheme shifts if user theme mode is set to 'auto'
      if ((this.#settings.theme ?? DEFAULT_THEME_MODE) === 'auto') {
         this.#applyTheme();
      }
   };

   /**
    * Attaches change event listener to the prefers-color-scheme media query.
    *
    * @private
    */
   #listenForSystemThemeChanges = () => {
      this.#mediaQuery?.addEventListener('change', this.#handleSystemThemeChange);
   };
}

// Auto-initialize theme manager when module is loaded
new ThemeManager().init();
