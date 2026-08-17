import browser from '../libs/browser-support.js';
import { MSG } from '../message-types.js';
import { i18n } from '../libs/localization.js';
import { escapeHTML, sanitizeSafeUrl } from '../ui/utils/dom-utils.js';
import { sendMessageWithRetry } from '../libs/message-service.js';
import { isRestrictedUrl } from '../constants.js';
import { excludeRuleAppliesToHostname, formatSiteExcludeRule, normalizeCustomUrlsExcludes } from '../libs/origin-guard.js';

/** @type {Array<{name: string, shortName: string, searchUrlTemplate: string, isPrimary: boolean, flow?: string}>} */
const SCRIPT_SOURCES = [
   {
      name: 'Userscript.Zone',
      shortName: 'US.Zone',
      searchUrlTemplate: 'https://www.userscript.zone/search?source=index&q={domain}',
      isPrimary: true,
      // flow: '',
   },
   {
      name: 'GreasyFork',
      shortName: 'GF',
      searchUrlTemplate: 'https://greasyfork.org/scripts/by-site/{domain}',
      isPrimary: false,
      // flow: '',
   },
   {
      name: 'SleazyFork',
      shortName: 'SF',
      searchUrlTemplate: 'https://sleazyfork.org/scripts/by-site/{domain}',
      isPrimary: false,
      // flow: '',
   },
   {
      name: 'OpenUserJS',
      shortName: 'OUJS',
      searchUrlTemplate: 'https://openuserjs.org/?q={domain}',
      isPrimary: false,
      // flow: '',
   },
   {
      name: 'Awesome Userscripts',
      shortName: 'AUS',
      searchUrlTemplate: 'https://github.com/awesome-scripts/awesome-userscripts/search?q={domain}',
      isPrimary: false,
      flow: 'left',
   },
];

/**
 * Manages UI rendering and interactions for the extension's browser action popup.
 */
class PopupUI {
   #elements;
   #activeTab;

   /** @type {Array<Object>} Cached list of scripts applicable to the active tab */
   #scripts = [];

   /** @type {AbortController|null} AbortController for tearing down log modal listeners */
   #logModalAbortController = null;

   /** @type {boolean} Guard flag preventing duplicate global event listener bindings */
   #listenersAttached = false;

   constructor() {
      this.#elements = this.#queryElements();
      this.#init();
   }

   /**
    * Caches popup DOM element references.
    * @private
    * @returns {Record<string, HTMLElement|null>}
    */
   #queryElements() {
      const selectors = {
         list: '#script-list',
         newScriptBtn: '#new-script-btn',
         openOptionsBtn: '#open-options-btn',
         pauseSwitch: '#pause-switch',
         refreshPrompt: '#refresh-prompt',
         reloadTabBtn: '#reload-tab-btn',
         logsModal: '#logs-modal',
         logsContent: '#logs-content',
         closeLogsModal: '#close-logs-modal',
         copyLogsBtn: '#copy-logs',
         clearLogsBtn: '#clear-logs',
         muteLogsBtn: '#mute-logs-btn',
         findScriptsContainer: '#find-scripts-container',
      };
      return Object.fromEntries(
         Object.entries(selectors).map(([key, selector]) => [key, document.querySelector(selector)])
      );
   }

   /**
    * Initializes active tab metadata, fetches applicable scripts, and renders popup UI.
    * @private
    */
   async #init() {
      try {
         const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
         this.#activeTab = activeTab;

         this.#attachGlobalEventListeners();
         this.#renderFindScriptsLinks(this.#activeTab?.url);

         // Properly handle tabs where tab.url is undefined due to optional permissions
         const isRestricted = isRestrictedUrl(this.#activeTab?.url);
         let isPaused = false;

         if (browser.storage?.session) {
            try {
               const storedPause = await browser.storage.session.get({ isPaused: false });
               isPaused = !!storedPause.isPaused;
            } catch (storageErr) {
               console.warn('[Popup] Session storage read failed:', storageErr);
            }
         }

         const { scripts = [] } = isRestricted || !this.#activeTab
            ? { scripts: [] }
            : await sendMessageWithRetry({
               type: MSG.GET_APPLICABLE_SCRIPTS,
               payload: { url: this.#activeTab?.url, tabId: this.#activeTab.id },
            });

         let sessionData = {};

         // Read temporary script instability diagnostic markers from session storage for active tab
         if (this.#activeTab?.id) {
            try {
               if (browser.storage?.session) {
                  const tabLogsKey = `tab_logs_${this.#activeTab.id}`;
                  const unstableKeys = scripts.map((script) => `unstable_${this.#activeTab.id}_${script.id}`);
                  sessionData = (await browser.storage.session.get([tabLogsKey, ...unstableKeys])) || {};
               }
            } catch (storageError) {
               console.warn('[Popup] Session storage access failed, diagnostics disabled:', storageError);
            }

            const tabLogsKey = `tab_logs_${this.#activeTab.id}`;
            const tabLogs = sessionData[tabLogsKey] || {};

            scripts.forEach((script) => {
               const unstableKey = `unstable_${this.#activeTab.id}_${script.id}`;
               script.isUnstable = !!sessionData[unstableKey];
               script.logCount = tabLogs[script.id]?.length || 0;
            });

            //    scripts.sort((a, b) => {
            //       const aEnabled = a.config?.enabled ?? false;
            //       const bEnabled = b.config?.enabled ?? false;
            //       if (aEnabled !== bEnabled) {
            //           return aEnabled ? -1 : 1; // true (enabled) идет первым
            //       }
            //       return (a.meta.name || '').localeCompare(b.meta.name || '');
            //   });
         }

         this.#scripts = scripts;
         this.#applyPauseUi(isPaused);
         this.#render(scripts);
      } catch (error) {
         console.error('[Popup] Initialization failed:', error);
         this.#renderError(i18n('popup_error_cant_connect'));
      }
   }

   /**
    * Binds top-level click, change, and navigation listeners.
    * @private
    */
   #attachGlobalEventListeners() {
      if (this.#listenersAttached) return;
      this.#listenersAttached = true;

      const openOptionsAndClose = (event) => {
         event.preventDefault();
         browser.runtime.openOptionsPage();
         window.close();
      };

      this.#elements.openOptionsBtn?.addEventListener('click', openOptionsAndClose);
      this.#elements.newScriptBtn?.addEventListener('click', (event) => {
         event.preventDefault();
         const optionsUrl = browser.runtime.getURL('html/options.html');
         const targetUrl = new URL(optionsUrl);
         if (this.#activeTab?.url) {
            targetUrl.searchParams.set('new_script_url', this.#activeTab.url);
         }
         browser.tabs.create({ url: targetUrl.href });
         window.close();
      });

      this.#elements.pauseSwitch?.addEventListener('change', this.#handlePauseToggle);
      this.#elements.reloadTabBtn?.addEventListener('click', this.#handleTabReload);

      this.#elements.list?.addEventListener('click', this.#handleListClick);
      this.#elements.list?.addEventListener('change', this.#handleListChange);
   }

   /**
    * Renders the script list items into the DOM.
    * @private
    * @param {Array<Object>} scripts
    */
   #render(scripts) {
      if (!this.#elements.list) return;

      if (!scripts.length) {
         this.#elements.list.innerHTML = `<li class="warning-message">${i18n('popup_no_scripts')}</li>`;
         return;
      }

      // Sort scripts: Active running scripts first, then site-excluded scripts, then globally disabled scripts
      const currentUrl = this.#activeTab?.url || '';
      let activeDomain = '';
      try {
         if (currentUrl && !isRestrictedUrl(currentUrl)) {
            activeDomain = new URL(currentUrl).hostname.replace(/^www\./i, '');
         }
      } catch {}

      const sortedScripts = [...scripts].sort((a, b) => {
         const aCustom = a.customUrls ? a.customUrls.split('\n').map((s) => s.trim()).filter(Boolean) : [];
         const bCustom = b.customUrls ? b.customUrls.split('\n').map((s) => s.trim()).filter(Boolean) : [];
         const aExcluded = activeDomain ? aCustom.some((l) => excludeRuleAppliesToHostname(l, activeDomain)) : false;
         const bExcluded = activeDomain ? bCustom.some((l) => excludeRuleAppliesToHostname(l, activeDomain)) : false;

         const aActive = (a.enabled ?? false) && !aExcluded;
         const bActive = (b.enabled ?? false) && !bExcluded;

         if (aActive !== bActive) return bActive - aActive;
         if (aExcluded !== bExcluded) return aExcluded - bExcluded;
         return (a.meta?.name ?? '').localeCompare(b.meta?.name ?? '');
      });

      const firstDisabledIndex = sortedScripts.findIndex((script) => !script.enabled);

      const scriptItemsHtml = sortedScripts
         .map((script, index) => {
            const isFirstDisabled = index > 0 && index === firstDisabledIndex;
            const separatorHtml = isFirstDisabled ? '<hr class="script-separator">' : '';
            return separatorHtml + this.#renderScriptItem(script);
         })
         .join('');

      this.#elements.list.innerHTML = scriptItemsHtml;
   }

   /**
    * Generates HTML string markup for an individual script item.
    * @private
    * @param {Object} script
    * @returns {string}
    */
   #renderScriptItem(script) {
      const {
         id,
         meta,
         iconDataUrl,
         type,
         commands = [],
         enabled,
         config = {},
         state = {},
         isUnstable = false,
         logCount = 0,
      } = script;

      const rawName = meta?.name ?? `Script ${id}`;
      const name = escapeHTML(rawName);

      const rawHomepage = meta?.homepageURL || meta?.homepage || meta?.website || (script.sourceUrl && !script.sourceUrl.startsWith('data:') ? script.sourceUrl : null);
      const safeHomepage = sanitizeSafeUrl(rawHomepage);
      const hasHomepage = safeHomepage && safeHomepage !== '#';

      const homepageHtml = hasHomepage
         ? `<a href="${safeHomepage}" target="_blank" rel="noopener noreferrer" class="script-homepage-link" tooltip="${escapeHTML(i18n('popup_open_homepage') || 'Open homepage')}" flow="right">
               <svg width="14" height="14" aria-hidden="true"><use xlink:href="#iconLink"></use></svg>
            </a>`
         : '';

      const isDisabledByPermissions = !enabled && (state.permissionError ?? false);
      const registrationError = state.registrationError;
      const hasAnomalies = Array.isArray(state.anomalies) && state.anomalies.length > 0;
      const tooltip = escapeHTML(
         isUnstable
            ? i18n('popup_unstable_script_warning')
            : registrationError
               ? registrationError
               : isDisabledByPermissions
                  ? i18n('popup_needs_permissions_tooltip')
                  : hasAnomalies
                     ? (state.anomalies || []).join('\n')
                     : rawName
      );

      const iconHtml = isUnstable || registrationError || hasAnomalies
         ? `<span class="script-warning-badge" title="${tooltip}">⚠️</span>`
         : iconDataUrl
            ? `<img src="${iconDataUrl}" alt="icon" class="script-icon">`
            : type === 'userstyle'
               ? '🎨'
               : '📜';

      const commandsHtml = commands.length
         ? `<ul class="commands-list">${commands
            .map(
               ({ commandId, caption }) =>
                  `<li class="command-item" data-command-id="${escapeHTML(commandId)}">${escapeHTML(caption)}</li>`
            )
            .join('')}</ul>`
         : '';

      const currentUrl = this.#activeTab?.url || '';
      let activeDomain = '';
      try {
         if (currentUrl && !isRestrictedUrl(currentUrl)) {
            activeDomain = new URL(currentUrl).hostname.replace(/^www\./i, '');
         }
      } catch {}

      const customLines = script.customUrls ? script.customUrls.split('\n').map((s) => s.trim()).filter(Boolean) : [];
      const isExcludedOnSite = activeDomain
         ? customLines.some((l) => excludeRuleAppliesToHostname(l, activeDomain))
         : false;

      const rawExcludeTooltip = isExcludedOnSite
         ? i18n('popup_unexclude_site_tooltip') || 'Excluded on $DOMAIN$ (click to unblock)'
         : i18n('popup_exclude_site_tooltip') || 'Exclude on $DOMAIN$';
      const excludeTooltip = rawExcludeTooltip.replace('$DOMAIN$', activeDomain || 'site');

      const isMutedInPopup = config.muteLogs ?? false;
      const hasLogs = logCount > 0;
      const isLogsBtnEnabled = !isMutedInPopup && hasLogs;

      let logsButtonTooltip = '';
      if (isMutedInPopup) {
         logsButtonTooltip = i18n('popup_logs_disabled_tooltip');
      } else if (!hasLogs) {
         logsButtonTooltip = i18n('popup_no_logs');
      } else {
         logsButtonTooltip = `${i18n('popup_show_logs_tooltip')} (${logCount})`;
      }

      return `
      <li class="script-item ${isUnstable ? 'is-unstable-script' : ''} ${isExcludedOnSite ? 'is-excluded-on-site' : ''}" data-script-id="${id}" title="${tooltip}">
            <div class="script-header">
               <div class="script-main">
                  <input type="checkbox" class="script-enable" id="script-toggle-${id}" ${enabled ? 'checked' : ''}>
                  ${iconHtml}
                  <label for="script-toggle-${id}" title="${tooltip}">${name}</label>
                  ${homepageHtml}
               </div>
               <div class="script-actions">
                  <button class="script-logs-btn ${hasLogs ? 'has-logs' : ''}" ${!isLogsBtnEnabled ? 'disabled' : ''} title="${escapeHTML(logsButtonTooltip)}">
                     <svg width="18" height="18"><use xlink:href="#iconConsole"/></svg>
                     ${hasLogs ? `<span class="log-count-badge">${logCount}</span>` : ''}
                  </button>
                  <button class="script-exclude-btn ${isExcludedOnSite ? 'is-excluded' : ''}" ${!activeDomain ? 'disabled' : ''} tooltip="${escapeHTML(excludeTooltip)}" flow="left">
                     <svg width="18" height="18"><use xlink:href="#iconBlock"/></svg>
                  </button>
                  <button class="script-edit-btn" tooltip="${escapeHTML(
            i18n('popup_edit_script_tooltip')
         )}" flow="left"><svg width="18" height="18"><use xlink:href="#iconEdit"/></svg></button>
                  <button class="script-remove-btn" tooltip="${escapeHTML(
            i18n('tooltip_remove_script')
         )}" flow="left"><svg><use xlink:href="#iconRemove"/></svg></button>
               </div>
            </div>
            ${commandsHtml}
         </li>`;
   }

   /**
    * Renders an error message in the list container.
    * @private
    * @param {string} message
    */
   #renderError(message) {
      if (this.#elements.list) {
         this.#elements.list.innerHTML = `<li class="error-item warning-message">${message}</li>`;
      }
   }

   /**
    * Renders external userscript repository search links based on the active tab domain.
    * @private
    * @param {string} [url]
    */
   #renderFindScriptsLinks(url) {
      const { findScriptsContainer: container } = this.#elements;
      if (!container) return;

      if (!url || isRestrictedUrl(url)) {
         container.classList.add('hide');
         return;
      }

      try {
         const domain = new URL(url).hostname;
         if (!domain) {
            container.classList.add('hide');
            return;
         }
         const [primary, ...others] = [...SCRIPT_SOURCES].sort(
            (a, b) => (b.isPrimary ?? false) - (a.isPrimary ?? false)
         );

         const primaryLink = `
            <a href="${escapeHTML(
            primary.searchUrlTemplate.replace('{domain}', domain)
         )}" target="_blank" class="find-scripts-link">
               <svg width="16" height="16" viewBox="0 0 24 24"><use xlink:href="#iconSearch"></use></svg>
               <span>${escapeHTML(i18n('popup_find_scripts_btn'))}</span>
            </a>`;

         const secondaryLinks = others.length
            ? `<span class="site-links"> / ${others
               .map(
                  (s) =>
                     `<a href="${escapeHTML(
                        s.searchUrlTemplate.replace('{domain}', domain)
                     )}" target="_blank" tooltip="Search on ${escapeHTML(s.name)}" flow="${escapeHTML(
                        s.flow ?? 'up'
                     )}">${escapeHTML(s.shortName)}</a>`
               )
               .join(' / ')}</span>`
            : '';

         container.innerHTML = primaryLink + secondaryLinks;
         container.classList.remove('hide');
      } catch {
         container.classList.add('hide');
         console.warn('[Popup] Could not parse URL for find scripts link:', url);
      }
   }

   /**
    * Handles extension global pause toggle changes.
    * @private
    * @param {Event} event
    */
   #handlePauseToggle = async ({ target }) => {
      const isPaused = !target.checked;
      await sendMessageWithRetry({ type: MSG.SET_PAUSE_STATE, payload: { isPaused } });
      this.#applyPauseUi(isPaused);
      this.#showRefreshPrompt();
   };

   /**
    * Syncs pause switch, dimmed list, and pause/resume tooltip with the current pause flag.
    * @private
    * @param {boolean} isPaused
    */
   #applyPauseUi(isPaused) {
      if (this.#elements.pauseSwitch) {
         this.#elements.pauseSwitch.checked = !isPaused;
      }
      this.#elements.list?.classList.toggle('is-paused', isPaused);
      const label = i18n(isPaused ? 'popup_btn_resume_all' : 'popup_btn_pause_all');
      this.#elements.pauseSwitch?.setAttribute('aria-label', label);
      this.#elements.pauseSwitch?.closest('.pause-wrapper')?.setAttribute('tooltip', label);
   }

   /**
    * Reloads the current active tab.
    * @private
    */
   #handleTabReload = () => {
      this.#elements.refreshPrompt?.classList.add('hide');
      if (this.#activeTab?.id) {
         browser.tabs.reload(this.#activeTab.id);
         window.close();
      }
   };

   /**
    * Delegated click handler for list items (edit, remove, logs, menu command execution).
    * @private
    * @param {MouseEvent} event
    */
   #handleListClick = async ({ target }) => {
      const scriptItem = target.closest('.script-item[data-script-id]');
      if (!scriptItem) return;
      const scriptId = Number(scriptItem.dataset.scriptId);

      if (target.closest('.script-edit-btn')) {
         await sendMessageWithRetry({ type: MSG.OPEN_SCRIPT_IN_EDITOR, payload: { scriptId } });
         window.close();
      } else if (target.closest('.script-remove-btn')) {
         if (confirm(i18n('opt_script_remove_confirm'))) {
            await sendMessageWithRetry({ type: MSG.DELETE_SCRIPT, payload: { scriptId } });
            this.#init(); // Refresh script list
         }
      } else if (target.closest('.script-exclude-btn')) {
         const currentUrl = this.#activeTab?.url;
         if (!currentUrl || isRestrictedUrl(currentUrl)) return;

         let domain = '';
         try {
            domain = new URL(currentUrl).hostname.replace(/^www\./i, '');
         } catch {
            return;
         }

         const script = this.#scripts.find((s) => s.id === scriptId);
         if (!script) return;

         const currentCustom = normalizeCustomUrlsExcludes((script.customUrls || '').trim()) || '';
         const lines = currentCustom ? currentCustom.split('\n').map((s) => s.trim()).filter(Boolean) : [];
         const isExcluded = lines.some((l) => excludeRuleAppliesToHostname(l, domain));

         let newLines;
         if (isExcluded) {
            newLines = lines.filter((l) => !excludeRuleAppliesToHostname(l, domain));
         } else {
            newLines = [...lines, formatSiteExcludeRule(domain)];
         }

         const newCustomUrls = newLines.length > 0 ? newLines.join('\n') : null;

         const response = await sendMessageWithRetry({
            type: MSG.UPDATE_SCRIPT_PROPS,
            payload: { scriptId, props: { customUrls: newCustomUrls } },
         });

         if (response?.success) {
            script.customUrls = newCustomUrls;
            this.#showRefreshPrompt();
            this.#render(this.#scripts);
         }
      } else if (target.closest('.script-logs-btn')) {
         this.#showLogsModal(scriptId);
      } else if (target.matches('.command-item')) {
         await sendMessageWithRetry({
            type: MSG.EXECUTE_MENU_COMMAND,
            payload: {
               tabId: this.#activeTab?.id,
               scriptId,
               commandId: target.dataset.commandId
            },
         });
         window.close();
      }
   };

   /**
    * Delegated change handler for script enable toggles.
    * @private
    * @param {Event} event
    */
   #handleListChange = async ({ target }) => {
      const scriptItem = target.closest('.script-item[data-script-id]');
      if (!target.matches('input.script-enable') || !scriptItem) return;

      const scriptId = Number(scriptItem.dataset.scriptId);
      const isEnabled = target.checked;

      try {
         const response = await sendMessageWithRetry({
            type: MSG.UPDATE_SCRIPT_PROPS,
            payload: { scriptId, props: { enabled: isEnabled } },
         });

         // Check if host permissions are required
         if (response?.needsPermissions) {
            try {
               // Trigger system permission prompt directly from Popup UI
               const granted = await browser.permissions.request(response.details);

               if (granted) {
                  // Re-save script in enabled state after permissions granted
                  const finalResponse = await sendMessageWithRetry({
                     type: MSG.UPDATE_SCRIPT_PROPS,
                     payload: { scriptId, props: { enabled: true } },
                  });

                  if (finalResponse?.success) {
                     const script = this.#scripts.find(s => s.id === scriptId);
                     if (script) script.enabled = true;
                     this.#showRefreshPrompt();
                     this.#render(this.#scripts);
                  } else {
                     throw new Error(finalResponse?.error || 'Failed to enable script.');
                  }
               } else {
                  // Uncheck toggle if user declined requested permissions
                  target.checked = false;
               }
            } catch (permErr) {
               console.error('[Popup] Permission request failed:', permErr);
               target.checked = false;
               alert(i18n('popup_alert_permissions_needed'));
            }
         } else if (response?.success) {
            const script = this.#scripts.find(s => s.id === scriptId);
            if (script) script.enabled = isEnabled;
            this.#showRefreshPrompt();
            this.#render(this.#scripts);
         } else {
            throw new Error(response?.error ?? 'Unknown error');
         }
      } catch (error) {
         target.checked = !isEnabled; // Revert checkbox on failure
         console.error('[Popup] Failed to update script status:', error);
         alert(`${i18n('popup_alert_update_failed')}\n\n${error.message}`);
      }
   };

   /**
    * Displays prompt recommending tab reload after changes.
    * @private
    */
   #showRefreshPrompt() {
      this.#elements.refreshPrompt?.classList.remove('hide');
   }

   /**
    * Fetches execution logs for active tab and displays log viewer modal.
    * @private
    * @param {number} scriptId
    */
   async #showLogsModal(scriptId) {
      try {
         // Wrapped IPC request in try-catch to handle background connection failures gracefully
         const { logs } = await sendMessageWithRetry({
            type: MSG.GET_LOGS_FOR_TAB,
            payload: { tabId: this.#activeTab?.id },
         });
         const scriptLogs = logs?.[scriptId] ?? [];

         const formatLogEntry = (log) => `
         <div class="log-entry ${log.level}">
            <div class="log-meta"><span>[${log.level.toUpperCase()}]</span><span>${new Date(
            log.timestamp
         ).toLocaleTimeString()}</span></div>
            <div class="log-message">${escapeHTML(log.message)}</div>
            ${log.stack ? `<div class="log-stack">${escapeHTML(log.stack)}</div>` : ''}
         </div>`;

         if (this.#elements.logsContent) {
            this.#elements.logsContent.innerHTML = scriptLogs.length
               ? scriptLogs.map(formatLogEntry).join('')
               : `<p>${i18n('popup_no_logs')}</p>`;
         }

         this.#elements.logsModal?.classList.remove('hide');
         this.#setupLogsModalHandlers(scriptId);

         // Expand extension popup window dimensions when logs exist to provide adequate viewing area
         if (scriptLogs.length) {
            Object.assign(document.body.style, { height: '580px', width: '700px', maxWidth: '700px' });
         }
      } catch (err) {
         console.error('[Popup] Failed to show logs modal:', err);
         if (this.#elements.logsContent) {
            this.#elements.logsContent.innerHTML = `<p class="warning-message">${escapeHTML(i18n('popup_error_cant_connect'))}</p>`;
         }
         this.#elements.logsModal?.classList.remove('hide');
         this.#setupLogsModalHandlers(scriptId);
      }
   }

   /**
    * Binds modal action buttons using an AbortController signal for teardown.
    * @private
    * @param {number} scriptId
    */
   #setupLogsModalHandlers(scriptId) {
      this.#logModalAbortController?.abort();
      this.#logModalAbortController = new AbortController();
      const { signal } = this.#logModalAbortController;
      const { closeLogsModal, copyLogsBtn, clearLogsBtn, muteLogsBtn } = this.#elements;

      if (copyLogsBtn) copyLogsBtn.disabled = false;
      if (clearLogsBtn) clearLogsBtn.disabled = false;
      if (muteLogsBtn) muteLogsBtn.disabled = false;

      closeLogsModal?.addEventListener('click', this.#closeLogsModal, { signal });
      this.#elements.logsModal?.addEventListener('click', (event) => {
         if (event.target === this.#elements.logsModal) this.#closeLogsModal();
      }, { signal });
      document.addEventListener('keydown', (event) => {
         if (event.key === 'Escape') this.#closeLogsModal();
      }, { signal });
      copyLogsBtn?.addEventListener('click', this.#copyLogsToClipboard, { signal });
      clearLogsBtn?.addEventListener('click', () => this.#clearLogsForScript(scriptId), { signal });

      const script = this.#scripts.find((s) => s.id === scriptId);
      if (script && muteLogsBtn) {
         muteLogsBtn.style.display = 'inline-block';
         this.#updateMuteButton(script.config?.muteLogs);
         muteLogsBtn.addEventListener('click', () => this.#toggleMute(script), { signal });
      } else if (muteLogsBtn) {
         muteLogsBtn.style.display = 'none';
      }
   }

   /**
    * Updates mute logs action button label.
    * @private
    * @param {boolean} isMuted
    */
   #updateMuteButton(isMuted) {
      if (this.#elements.muteLogsBtn) {
         this.#elements.muteLogsBtn.textContent = i18n(isMuted ? 'popup_btn_unmute_logs' : 'popup_btn_mute_logs');
      }
   }

   /**
    * Toggles log output suppression for a specific script.
    * @private
    * @param {Object} script
    */
   async #toggleMute(script) {
      if (this.#elements.muteLogsBtn) this.#elements.muteLogsBtn.disabled = true;
      const newMuteState = !script.config?.muteLogs;
      try {
         const response = await sendMessageWithRetry({
            type: MSG.UPDATE_SCRIPT_PROPS,
            payload: { scriptId: script.id, props: { config: { muteLogs: newMuteState } } },
         });
         if (!response?.success) throw new Error(response?.error);

         script.config ??= {};
         script.config.muteLogs = newMuteState;
         alert(i18n(newMuteState ? 'popup_toast_logs_muted' : 'popup_toast_logs_unmuted'));
         this.#updateMuteButton(newMuteState);
         this.#showRefreshPrompt();
         this.#render(this.#scripts);
      } catch (error) {
         console.error('[Popup] Failed to update mute state:', error);
         alert(i18n('popup_alert_update_failed'));
      } finally {
         if (this.#elements.muteLogsBtn) this.#elements.muteLogsBtn.disabled = false;
      }
   }

   /**
    * Closes log viewer modal and restores default popup window dimensions.
    * @private
    */
   #closeLogsModal = () => {
      this.#logModalAbortController?.abort();
      this.#elements.logsModal?.classList.add('hide');
      Object.assign(document.body.style, { height: '', width: '', maxWidth: '' });
   };

   /**
    * Copies formatted log text content to user clipboard.
    * @private
    */
   #copyLogsToClipboard = () => {
      if (this.#elements.logsContent) {
         navigator.clipboard
            .writeText(this.#elements.logsContent.innerText)
            .catch((err) => console.error('Failed to copy logs:', err));
      }
   };

   /**
    * Clears accumulated tab execution logs for script.
    * @private
    * @param {number} scriptId
    */
   #clearLogsForScript = async (scriptId) => {
      try {
         await sendMessageWithRetry({
            type: MSG.CLEAR_LOGS_FOR_SCRIPT_IN_TAB,
            payload: { scriptId, tabId: this.#activeTab?.id },
         });
         if (this.#elements.logsContent) {
            this.#elements.logsContent.innerHTML = `<p>${i18n('popup_logs_cleared')}</p>`;
         }
         const script = this.#scripts.find((s) => s.id === scriptId);
         if (script) script.logCount = 0;
         this.#render(this.#scripts);
      } catch (err) {
         console.error('Failed to clear logs:', err);
      }
   };
}

// Initialize popup UI on DOM load
document.addEventListener('DOMContentLoaded', () => new PopupUI());
