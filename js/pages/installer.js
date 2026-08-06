import { CodeMirrorAdapter } from '../ui/adapters/editor-adapters.js';
import browser from '../libs/browser-support.js';
import { MetadataParser } from '../libs/meta-parser.js';
import { MSG } from '../message-types.js';
import { i18n } from '../libs/localization.js';
import { escapeHTML } from '../ui/utils/dom-utils.js';
import { logger } from '../libs/logger.js';
import { sendMessageWithRetry } from '../libs/message-service.js';
import { TRUSTED_SCRIPT_HOSTS, MAX_SCRIPT_SIZE, isTrustedScriptHost } from '../constants.js';

const CONTEXT = 'InstallerUI';

/** @type {Set<string>} Match patterns indicating broad global web access */
const ALL_SITES_PATTERNS = new Set(['<all_urls>', '*://*/*', '*://*', '*://*/*/*']);

/**
 * Handles the UI and logic for the script installation page.
 * Fetches script metadata, compares with existing installations,
 * displays security warnings, and guides the user through installation.
 */
class InstallerUI {
   #elements;
   #scriptData = null;
   #existingScriptInfo = null;
   #codeEditorAdapter = null;

   /** @type {boolean} Prevents attaching duplicate event listeners to source preview toggle button */
   #isSourceToggleAttached = false;

   constructor() {
      this.#elements = this.#queryElements();
      this.#initialize();
   }

   /**
    * Queries and caches installer DOM element references.
    * @private
    * @returns {Record<string, HTMLElement|null>}
    */
   #queryElements() {
      const selectors = {
         container: '.installer',
         errorMessage: '#error-message',
         metaList: '#meta-list',
         installBtn: '#install-btn',
         cancelBtn: '#cancel-btn',
      };
      return Object.fromEntries(
         Object.entries(selectors).map(([key, selector]) => [key, document.querySelector(selector)])
      );
   }

   /**
    * Initializes event listeners and begins fetching the script.
    * @private
    */
   async #initialize() {
      if (window.self !== window.top) {
         document.body.innerHTML = '<div style="padding: 20px; color: red; text-align: center;"><h2>Security Error</h2><p>Installer cannot be framed.</p></div>';
         throw new Error('Clickjacking protection triggered: Installer cannot be framed.');
      }

      this.#elements.installBtn.addEventListener('click', () => this.#install());
      this.#elements.cancelBtn.addEventListener('click', () => this.#handleCancel());

      try {
         const url = this.#getUrlParam('url');
         if (!url) throw new Error(i18n('installer_error_no_url'));
         await this.#loadScriptFromURL(url);
      } catch (err) {
         this.#renderError(err.message);
      }
   }

   /**
    * Loads, parses, and validates script source code from a URL.
    * @private
    * @param {string} url Target URL of the .user.js script
    */
   async #loadScriptFromURL(url) {
      const MAX_SCRIPT_SIZE = 5 * 1024 * 1024; // 5MB limit
      this._setUIState('loading');

      let response;
      try {
         // Enforce 15-second network timeout to prevent UI hanging indefinitely on poor connections
         const controller = new AbortController();
         const timeoutId = setTimeout(() => controller.abort(), 15000);

         response = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
      } catch (networkError) {
         logger.error(CONTEXT, 'Network error during fetch:', networkError);
         throw new Error(i18n('installer_error_fetch_failed'));
      }

      if (!response.ok) {
         throw new Error(i18n('installer_error_http_status', [String(response.status)]));
      }

      // Check Content-Length header to fail fast before reading huge non-script files into memory
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_SCRIPT_SIZE) {
         throw new Error(i18n('installer_error_script_too_large'));
      }

      const userCode = await response.text();

      // Secondary Blob size validation
      if (new Blob([userCode]).size > MAX_SCRIPT_SIZE) {
         throw new Error(i18n('installer_error_script_too_large'));
      }

      const { meta } = MetadataParser.parse(userCode);
      if (!meta.name) throw new Error(i18n('installer_error_no_meta'));

      this.#scriptData = { userCode, meta, sourceUrl: url };

      const { existingScript } = await sendMessageWithRetry({
         type: MSG.CHECK_SCRIPT_EXISTS,
         payload: { name: meta.name, namespace: meta.namespace },
      });
      this.#existingScriptInfo = existingScript;

      this.#render();
      this._setUIState('ready');
   }

   /**
    * Renders script metadata, permissions, warnings, and source preview.
    * @private
    */
   async #render() {
      const { meta, sourceUrl } = this.#scriptData;
      const localizedDescription = meta[`description:${this.#getLanguageCode()}`] ?? meta.description;

      // Extract and clean target execution domains
      const matches = [].concat(meta.match || [], meta.include || []).filter(Boolean);
      const connects = [].concat(meta.connect || []).filter(Boolean);

      // Locale-independent check for broad web access permissions
      const hasAllSites = matches.some((p) => ALL_SITES_PATTERNS.has(p));

      /**
       * Cleans URL match patterns into user-friendly domain names.
       * @param {string} pattern
       * @returns {string}
       */
      const getCleanDomain = (pattern) => {
         if (ALL_SITES_PATTERNS.has(pattern)) {
            return i18n('installer_all_sites') || 'All websites';
         }
         try {
            const urlStr = pattern.replace(/^\*:\/\//, 'https://').replace(/^\/\//, 'https://');
            const url = new URL(urlStr);
            // Decode hostname to restore unescaped wildcard asterisks
            return decodeURIComponent(url.hostname);
         } catch {
            return pattern; // Fallback to raw string if URL parsing fails
         }
      };

      const uniqueDomains = [...new Set(matches.map(getCleanDomain))];
      const domainsText = uniqueDomains.join(', ');

      // Assemble grid metadata fields
      const metadata = {
         name: meta.name,
         version: meta.version,
         author: meta.author,
         description: localizedDescription,
         runs_on: domainsText,
         ...(connects.length > 0 && { connects_to: connects.join(', ') }),
         source: sourceUrl,
      };

      const { versionHtml, installAction } = this.#getVersionInfo();

      // Render metadata grid with dynamic permission highlighting
      this.#elements.metaList.innerHTML = Object.entries(metadata)
         .filter(([, value]) => value)
         .map(([key, value]) => {
            let valueHtml = escapeHTML(value);

            if (key === 'version') {
               valueHtml = versionHtml;
            } else if (key === 'runs_on') {
               if (hasAllSites) {
                  valueHtml = `<span style="color: var(--color-error); font-weight: bold;">⚠️ ${escapeHTML(
                     value
                  )}</span>`;
               } else {
                  valueHtml = `<span style="color: var(--color-primary); font-weight: bold;">${escapeHTML(
                     value
                  )}</span>`;
               }
            } else if (key === 'connects_to') {
               valueHtml = `<span style="color: var(--color-warning); font-weight: bold;">${escapeHTML(
                  value
               )}</span>`;
            }

            return `
               <dt class="meta-grid__key">${i18n(`installer_meta_${key}`) || key}</dt>
               <dd class="meta-grid__value" data-meta-key="${key}">
                  ${valueHtml}
               </dd>
            `;
         })
         .join('');

      this.#updateInstallButton(installAction);

      // Render security and host permission warnings
      const warningsContainer = document.getElementById('installer-warnings');
      if (warningsContainer) {
         warningsContainer.innerHTML = '';
         const warningMessages = [];

         // 1. Validate script source domain against known trusted hosts
         let isTrusted = false;
         try {
            isTrusted = isTrustedScriptHost(new URL(sourceUrl).hostname);
         } catch { }

         if (!isTrusted) {
            warningMessages.push(`
               <div class="warning-message" style="background-color: rgba(255, 193, 7, 0.08); border: 1px solid var(--color-notice-border); color: var(--color-text); text-align: left;">
                  ${i18n('installer_warning_untrusted')}
               </div>`);
         }

         // 2. Query background worker to check if script requests ungranted host or API permissions
         const permResult = await sendMessageWithRetry({
            type: MSG.CHECK_PERMISSIONS_FOR_SCRIPT,
            payload: { scriptObject: { meta } },
         }).catch(() => null);

         if (permResult) {
            const domainList = (permResult.origins || [])
               .map((o) => {
                  try {
                     return new URL(o.replace('*://', 'https://')).hostname;
                  } catch {
                     return o;
                  }
               })
               .filter(Boolean);

            const apiPermList = (permResult.permissions || []).filter(Boolean);

            // Only display domain warning if requested origins list is non-empty
            if (domainList.length > 0) {
               const domains = domainList.join(', ');
               warningMessages.push(`
                  <div class="warning-message" style="background-color: rgba(39, 166, 229, 0.08); border: 1px solid var(--color-primary); color: var(--color-text); text-align: left; font-style: normal;">
                     ${i18n('installer_warning_permissions', [domains])}
                  </div>`);
            }

            // Render separate warning for requested extension API permissions
            if (apiPermList.length > 0) {
               const apis = apiPermList.join(', ');
               warningMessages.push(`
                  <div class="warning-message" style="background-color: rgba(39, 166, 229, 0.08); border: 1px solid var(--color-primary); color: var(--color-text); text-align: left; font-style: normal;">
                     ${i18n('installer_warning_api_permissions', [escapeHTML(apis)])}
                  </div>`);
            }
         }

         if (warningMessages.length > 0) {
            warningsContainer.innerHTML = warningMessages.join('');
            warningsContainer.classList.remove('hide');
         } else {
            warningsContainer.classList.add('hide');
         }
      }

      const toggleBtn = document.getElementById('toggle-source-btn');
      const sourceContainer = document.getElementById('source-code-container');
      const editorWrapper = document.getElementById('source-code-editor');
      const contentEl = document.getElementById('content');
      const lineCountEl = document.getElementById('code-line-count');
      const copyBtn = document.getElementById('copy-source-btn');
      const installerContainer = document.querySelector('.installer');

      if (toggleBtn && sourceContainer && editorWrapper) {
         if (!this.#isSourceToggleAttached) {
            this.#isSourceToggleAttached = true;

            toggleBtn.addEventListener('click', () => {
               const isHidden = sourceContainer.classList.contains('hide');

               if (isHidden && !this.#codeEditorAdapter) {
                  const code = this.#scriptData.userCode || '';
                  const scriptType = this.#scriptData.meta?.type || 'userscript';

                  this.#codeEditorAdapter = new CodeMirrorAdapter(editorWrapper, code, scriptType, true);
                  this.#codeEditorAdapter.setReadOnly(true);

                  if (lineCountEl) {
                     const lines = code.split('\n').length;
                     const bytes = new Blob([code]).size;
                     const formattedSize = bytes < 1024
                        ? `${bytes} B`
                        : bytes < 1024 * 1024
                           ? `${(bytes / 1024).toFixed(1)} KB`
                           : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
                     lineCountEl.textContent = `${lines} lines • ${formattedSize}`;
                  }
               }

               sourceContainer.classList.toggle('hide', !isHidden);
               contentEl?.classList.toggle('has-code-view', isHidden);
               installerContainer?.classList.toggle('has-open-code', isHidden);
               toggleBtn.textContent = isHidden ? i18n('installer_btn_hide_source') : i18n('installer_btn_view_source');
            });

            if (copyBtn) {
               copyBtn.addEventListener('click', async () => {
                  if (!this.#scriptData?.userCode) return;
                  try {
                     await navigator.clipboard.writeText(this.#scriptData.userCode);
                     const originalText = copyBtn.textContent;
                     copyBtn.textContent = 'Copied! ✓';
                     setTimeout(() => { copyBtn.textContent = originalText; }, 2000);
                  } catch (err) {
                     logger.warn(CONTEXT, 'Failed to copy source code to clipboard:', err);
                  }
               });
            }
         }
      }
   }

   /**
    * Compares versions and returns installation action and version HTML display.
    * @private
    * @returns {{versionHtml: string, installAction: 'install'|'update'|'downgrade'|'reinstall'}}
    */
   #getVersionInfo() {
      const newVersion = this.#scriptData.meta.version;
      const oldVersion = this.#existingScriptInfo?.version;

      if (!this.#existingScriptInfo) {
         return {
            versionHtml: escapeHTML(newVersion ?? 'N/A'),
            installAction: 'install',
         };
      }

      const installAction = this.#determineInstallAction(oldVersion, newVersion);

      const versionHtml =
         installAction === 'reinstall'
            ? escapeHTML(newVersion ?? 'N/A')
            : this.#getVersionDisplay(oldVersion, newVersion);

      return {
         versionHtml,
         installAction,
      };
   }

   /**
    * Generates HTML markup displaying version changes with an arrow.
    * @private
    * @param {string} [oldVer]
    * @param {string} [newVer]
    * @returns {string}
    */
   #getVersionDisplay(oldVer, newVer) {
      return `
         <span class="version--old">${escapeHTML(oldVer ?? 'N/A')}</span>
         <span class="version--arrow">&rarr;</span>
         <span class="version--new">${escapeHTML(newVer ?? 'N/A')}</span>
      `;
   }

   /**
    * Compares version numbers semantically.
    * @private
    * @param {string} [oldVer]
    * @param {string} [newVer]
    * @returns {'update' | 'downgrade' | 'reinstall'}
    */
   #determineInstallAction(oldVer, newVer) {
      const comparison = (newVer ?? '0').localeCompare(oldVer ?? '0', undefined, { numeric: true });
      if (comparison > 0) return 'update';
      if (comparison < 0) return 'downgrade';
      return 'reinstall';
   }

   /**
    * Updates install button action text and styling.
    * @private
    * @param {'install'|'update'|'downgrade'|'reinstall'} action
    */
   #updateInstallButton(action) {
      const { installBtn, metaList } = this.#elements;
      installBtn.textContent = i18n(`installer_btn_${action}`);
      installBtn.className = `btn ${action === 'downgrade' ? 'btn-warning' : 'btn-primary'}`;

      const versionDisplay = metaList.querySelector('[data-meta-key="version"]');
      versionDisplay?.classList.toggle('is-update', action === 'update');
      versionDisplay?.classList.toggle('is-downgrade', action === 'downgrade');
   }

   /**
    * Initiates installation, prompts for host permissions if required, and saves script.
    * @private
    */
   async #install() {
      if (!this.#scriptData) return;
      this._setUIState('installing');

      try {
         const payload = this.#createInstallPayload();
         const response = await sendMessageWithRetry({ type: MSG.INSTALL_SCRIPT_FROM_URL, payload });

         if (response?.success) {
            if (response.needsPermissions) {
               // Request missing origin permissions directly within installer tab
               let granted = false;
               try {
                  granted = await browser.permissions.request(response.details);
               } catch (permErr) {
                  logger.warn(CONTEXT, 'Permission request rejected or failed:', permErr);
               }

               await sendMessageWithRetry({
                  type: MSG.SAVE_SCRIPT,
                  payload: {
                     scriptObject: {
                        ...response.scriptObject,
                        enabled: granted,
                        state: { permissionError: !granted },
                     },
                  },
               });

               if (!granted) {
                  alert(i18n('installer_alert_permission_denied'));
               }
            }
            this.#closePage();
         } else {
            throw new Error(response?.error || i18n('installer_error_unknown'));
         }
      } catch (err) {
         this.#renderError(i18n('installer_error_save_failed', [err.message]));
      }
   }

   /**
    * Prepares message payload for script installation.
    * @private
    * @returns {Object}
    */
   #createInstallPayload() {
      const { userCode, sourceUrl } = this.#scriptData;
      return {
         userCode,
         sourceUrl,
         existingId: this.#existingScriptInfo?.id ?? null,
         installerUrl: this.#getUrlParam('ref'),
      };
   }

   /**
    * Renders error message and transitions UI state to error.
    * @private
    * @param {string} message
    */
   #renderError(message) {
      logger.error(CONTEXT, 'Render error:', message);
      this.#elements.errorMessage.textContent = message;
      this._setUIState('error');
   }

   /**
    * Closes the current installer tab or window.
    * @private
    */
   async #closePage() {
      try {
         const tab = await browser.tabs.getCurrent();
         if (tab?.id) await browser.tabs.remove(tab.id);
         else window.close();
      } catch {
         window.close();
      }
   }

   /**
    * Sets UI state classes on the main installer container.
    * @param {'loading' | 'ready' | 'error' | 'installing'} state
    */
   _setUIState(state) {
      const { container, installBtn, cancelBtn } = this.#elements;
      const isCodeOpen = container.classList.contains('has-open-code');
      container.className = `installer${isCodeOpen ? ' has-open-code' : ''}`;
      installBtn.disabled = true;

      switch (state) {
         case 'loading':
            container.classList.add('is-loading');
            break;
         case 'ready':
            container.classList.add('is-ready');
            installBtn.disabled = false;
            break;
         case 'error':
            container.classList.add('has-error');
            cancelBtn.textContent = i18n('installer_btn_close');
            break;
         case 'installing':
            container.classList.add('is-ready');
            installBtn.textContent = i18n('installer_btn_installing');
            break;
      }
   }

   /**
    * Retrieves URL parameter value safely decoding full inner query strings.
    * @private
    * @param {string} name
    * @returns {string|null}
    */
   #getUrlParam(name) {
      // Parse location.href directly to preserve URL hash fragments during script intercept
      const href = window.location.href;
      const paramKey = `${name}=`;
      const idx = href.indexOf(paramKey);
      if (idx === -1) return null;

      const rawValue = href.substring(idx + paramKey.length);
      try {
         return decodeURIComponent(rawValue);
      } catch {
         return rawValue;
      }
   }

   /**
    * Returns user's two-letter browser language code.
    * @private
    * @returns {string}
    */
   #getLanguageCode() {
      return window.navigator.language.slice(0, 2);
   }

   /**
    * Navigates back in history or closes tab if history is empty.
    * @private
    */
   async #handleCancel() {
      if (window.history && window.history.length > 1) {
         window.history.back();
      } else {
         await this.#closePage();
      }
   }
}

// Initialize installer UI on DOM load
document.addEventListener('DOMContentLoaded', () => new InstallerUI());
