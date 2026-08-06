import browser from '../../libs/browser-support.js';
import { i18n } from '../../libs/localization.js';
import { escapeHTML, sanitizeSafeUrl } from '../../ui/utils/dom-utils.js';

/**
 * Utility for formatting timestamps into relative time strings (e.g., "5 minutes ago").
 */
class TimeFormatter {
   static #rtfCache = new Map();

   /**
    * Retrieves or creates a cached Intl.RelativeTimeFormat instance for a locale.
    * @private
    * @param {string} [locale]
    * @returns {Intl.RelativeTimeFormat}
    */
   static #getRtf(locale) {
      const key = locale ?? 'default';
      if (!this.#rtfCache.has(key)) {
         this.#rtfCache.set(key, new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }));
      }
      return this.#rtfCache.get(key);
   }

   /**
    * Formats a timestamp into a relative "time ago" string.
    * @param {number|Date} timestamp
    * @param {string} [locale]
    * @returns {string}
    */
   formatTimeAgo(timestamp, locale) {
      if (!timestamp) return '';
      const ts = timestamp instanceof Date ? timestamp.getTime() : timestamp;
      const now = Date.now();
      const diffMs = ts - now;
      const diffSec = Math.round(Math.abs(diffMs) / 1000);
      const direction = diffMs > 0 ? 1 : -1;

      const UNITS = [
         { unit: 'second', limit: 60, divisor: 1 },
         { unit: 'minute', limit: 3600, divisor: 60 },
         { unit: 'hour', limit: 86400, divisor: 3600 },
         { unit: 'day', limit: 604800, divisor: 86400 },
         { unit: 'week', limit: 2592000, divisor: 604800 },
         { unit: 'month', limit: 31536000, divisor: 2592000 },
         { unit: 'year', limit: Infinity, divisor: 31536000 },
      ];

      const matchedUnit = UNITS.find((u) => diffSec < u.limit) || UNITS[UNITS.length - 1];
      const value = Math.floor(diffSec / matchedUnit.divisor);
      const rtf = TimeFormatter.#getRtf(locale);
      return rtf.format(direction * value, matchedUnit.unit);
   }
}

/**
 * Manages rendering, filtering, sorting, selection, and interactions for the script sidebar list.
 */
export class ScriptListManager {
   #element;
   #searchInput;
   #sortSelect;
   #clearSearchBtn;
   #scripts = [];
   #selectedScriptId = null;
   #areLogsMutedGlobally = false;
   #currentFilter = '';
   #sortMode = 'position';
   #sortableInstance = null;
   #timeFormatter;
   #searchDebounceTimeout = null;

   /** @type {Map<string|number, { status: string, cloudFileId?: string, name?: string, version?: string }>|null} */
   #syncStatusMap = null;

   /**
    * @param {Object} [selectors={}] DOM selector options for list, search input, sort select, and clear search button.
    */
   constructor(selectors = {}) {
      this.#element = document.querySelector(selectors.list);
      this.#searchInput = document.querySelector(selectors.search);
      this.#sortSelect = document.querySelector(selectors.sort);
      this.#clearSearchBtn = document.querySelector(selectors.clearSearch);

      if (!this.#element) throw new Error('ScriptListManager: List element not found.');

      this.#timeFormatter = new TimeFormatter();
      this.#attachListeners();
      this.#initSortable();

      // Read stored sortMode preference from storage.local
      browser.storage?.local?.get({ sortMode: 'position' }).then(({ sortMode }) => {
         if (sortMode) {
            this.#sortMode = sortMode;
            if (this.#sortSelect) this.#sortSelect.value = sortMode;
            if (this.#scripts.length) this.#updateListView();
         }
      }).catch((err) => console.warn('ScriptListManager: Failed to load sortMode', err));
   }

   /**
    * Updates Google Drive sync status map and re-renders the script list.
    * @param {Map<string|number, Object>|null} statusMap
    */
   setSyncStatuses(statusMap) {
      this.#syncStatusMap = statusMap;
      this.#updateListView();
   }

   /**
    * Updates script list data and triggers a re-render.
    * @param {Array<Object>} scripts
    * @param {number|string|null} selectedScriptId
    * @param {boolean} areLogsMutedGlobally
    */
   render(scripts, selectedScriptId, areLogsMutedGlobally) {
      this.#scripts = scripts;
      this.#selectedScriptId = selectedScriptId;
      this.#areLogsMutedGlobally = areLogsMutedGlobally;
      this.#updateListView();
   }

   /**
    * Updates selected item state in the DOM without re-rendering the full list.
    * @param {number|string|null} scriptId
    */
   updateSelection(scriptId) {
      this.#selectedScriptId = scriptId;
      this.#element.querySelectorAll('.item.selected').forEach((el) => el.classList.remove('selected'));
      if (scriptId !== null) {
         this.#element.querySelector(`.item[data-script-id="${scriptId}"]`)?.classList.add('selected');
      }
   }

   /**
    * Reverts toggle state when updating a script property fails or is cancelled.
    * @param {number|string} scriptId
    * @param {string} prop
    * @param {boolean} originalValue
    */
   revertToggleState(scriptId, prop, originalValue) {
      const toggle = this.#element.querySelector(`.item[data-script-id="${scriptId}"] input[data-prop="${prop}"]`);
      if (toggle) toggle.checked = originalValue;
   }

   /**
    * Re-renders script items based on current filters, sort modes, and sync statuses.
    * @private
    */
   #updateListView() {
      const filter = this.#currentFilter.toLowerCase().trim();

      // 1. Shallow copy local scripts into working array
      let processedScripts = [...this.#scripts];

      // 2. Merge cloud-only virtual scripts from Google Drive sync map
      if (this.#syncStatusMap) {
         for (const [scriptIdOrUuid, info] of this.#syncStatusMap.entries()) {
            if (info.status === 'cloud_only') {
               processedScripts.push({
                  id: `cloud-${info.cloudFileId}`, // Virtual string ID for rendering
                  uuid: scriptIdOrUuid,
                  type: 'userscript',
                  enabled: false,
                  isCloudOnly: true,
                  meta: {
                     name: info.name || `Cloud Script ${scriptIdOrUuid.substring(0, 8)}`,
                     version: info.version || 'N/A',
                  },
                  cloudFileId: info.cloudFileId,
               });
            }
         }
      }

      // 3. Filter list by search query matching name, author, or URL rules
      processedScripts = processedScripts.filter((script) => {
         if (!filter) return true;

         const name = String(script.meta?.name || '').toLowerCase();
         const author = String(script.meta?.author || '').toLowerCase();

         const matches = [].concat(script.meta?.match || [], script.meta?.include || []);
         const excludes = [].concat(script.meta?.exclude || []);

         const isMatchRuleFound = matches.some((pattern) => String(pattern || '').toLowerCase().includes(filter));
         const isExcludeRuleFound = excludes.some((pattern) => String(pattern || '').toLowerCase().includes(filter));

         return (
            name.includes(filter) ||
            author.includes(filter) ||
            isMatchRuleFound ||
            isExcludeRuleFound
         );
      });

      // 4. Sort script list items
      processedScripts.sort((a, b) => {
         if (this.#sortMode === 'name-asc') return (a.meta?.name || '').localeCompare(b.meta?.name || '');
         if (this.#sortMode === 'name-desc') return (b.meta?.name || '').localeCompare(a.meta?.name || '');

         if (this.#sortMode === 'enabled') {
            const aEnabled = a.enabled ? 1 : 0;
            const bEnabled = b.enabled ? 1 : 0;
            if (aEnabled !== bEnabled) return bEnabled - aEnabled; // Enabled scripts first
            return (a.meta?.name || '').localeCompare(b.meta?.name || '');
         }

         if (this.#sortMode === 'updated') {
            return (b.updatedAt || 0) - (a.updatedAt || 0); // Newest updated first
         }

         // Order by position property (placing virtual cloud-only scripts at the bottom)
         return (a.position ?? Infinity) - (b.position ?? Infinity);
      });

      // 5. Render list items HTML
      this.#element.innerHTML = processedScripts.length
         ? processedScripts.map((script) => this.#createScriptListItemHTML(script)).join('')
         : `<li class="warning-message">${filter ? 'No scripts found' : i18n('opt_no_scripts_message')}</li>`;

      this.updateSelection(this.#selectedScriptId);

      // Disable drag-and-drop reordering when filtering or non-position sorting is active
      if (this.#sortableInstance) {
         const shouldDisableDrag = !!filter || this.#sortMode !== 'position';
         this.#clearSearchBtn?.classList.toggle('hide', !filter);
         this.#sortableInstance.option('disabled', shouldDisableDrag);
         this.#element.classList.toggle('sorting-disabled', shouldDisableDrag);
      }
   }

   /**
    * Generates HTML markup for a single script item.
    * @private
    * @param {Object} script
    * @returns {string}
    */
   #createScriptListItemHTML(script) {
      const name = script.meta?.name || `Script ${script.id}`;
      const authorHtml = this.#createAuthorHTML(script.meta?.author);

      const iconHtml = script.isCloudOnly
         ? `<span class="cloud-virtual">☁️</span>`
         : script.iconDataUrl
            ? `<img src="${script.iconDataUrl}" alt="icon">`
            : script.type === 'userstyle'
               ? '🎨'
               : '📜';

      const escapedNameAttr = escapeHTML(name);
      const highlightedName = this.#highlightText(escapeHTML(name), this.#currentFilter);

      let gdriveHtml = '';

      if (this.#syncStatusMap) {
         const syncInfo = this.#syncStatusMap.get(script.isCloudOnly ? script.uuid : script.id);
         const status = syncInfo?.status || 'not_synced';

         const statusTitles = {
            synced: i18n('gdrive_status_synced'),
            local_newer: i18n('gdrive_status_local_newer'),
            cloud_newer: i18n('gdrive_status_cloud_newer'),
            not_synced: i18n('gdrive_status_not_synced'),
            cloud_only: i18n('gdrive_status_cloud_only'),
         };

         const title = escapeHTML(statusTitles[status] || '');

         if (status === 'synced') {
            gdriveHtml = `
            <span class="gdrive-status-icon synced" title="${title}">
               <svg width="18" height="18"><use xlink:href="#iconCloudSynced"/></svg>
            </span>`;
         } else if (status === 'local_newer' || status === 'not_synced') {
            gdriveHtml = `
            <button class="gdrive-action-btn upload-btn ${status}" data-action="upload" title="${title}">
               <svg width="18" height="18"><use xlink:href="#iconCloudUpload"/></svg>
            </button>`;
         } else if (status === 'cloud_newer') {
            gdriveHtml = `
            <button class="gdrive-action-btn download-btn cloud_newer" data-action="download" title="${title}">
               <svg width="18" height="18"><use xlink:href="#iconCloudDownload"/></svg>
            </button>`;
         } else if (script.isCloudOnly) {
            gdriveHtml = `
            <div class="gdrive-controls-cloud-only">
               <button class="gdrive-action-btn download-btn cloud_only" data-action="download" title="${title}">
                  <svg width="18" height="18"><use xlink:href="#iconCloudDownload"/></svg>
               </button>
               <button class="gdrive-action-btn delete-cloud-btn" data-action="delete-cloud" title="Delete from Google Drive permanently">
                  <svg width="18" height="18"><use xlink:href="#iconRemove"/></svg>
               </button>
            </div>`;
         }
      }

      const isMuted = !!script.config?.muteLogs;
      const isMuteChecked = this.#areLogsMutedGlobally || isMuted;
      const isMuteDisabled = this.#areLogsMutedGlobally;
      const muteTooltip = escapeHTML(
         isMuteDisabled
            ? i18n('opt_tooltip_mute_disabled_globally')
            : i18n(isMuted ? 'opt_tooltip_unmute_in_console' : 'opt_tooltip_mute_in_console')
      );

      let versionHtml = '';
      if (script.meta?.version) {
         const currentVer = script.meta.version;
         const prevVer = script.state?.previousVersion;

         if (script.state?.highlightUpdate && prevVer && prevVer !== currentVer) {
            const title = escapeHTML(
               i18n('opt_version_updated_tooltip', [prevVer, currentVer]) ||
               `Updated from v${prevVer} to v${currentVer}`
            );
            versionHtml = `<span class="version is-update-display" title="${title}" style="color: var(--color-success); font-weight: bold;">v${escapeHTML(
               prevVer
            )} → v${escapeHTML(currentVer)}</span>`;
         } else {
            versionHtml = `<span class="version" title="Version">v${escapeHTML(currentVer)}</span>`;
         }
      }

      const safeSupportUrl = sanitizeSafeUrl(script.meta?.supportURL); // Sanitize URL protocol
      const supportLink =
         script.meta?.supportURL && safeSupportUrl !== '#' && !script.isCloudOnly
            ? `<a href="${safeSupportUrl}" tooltip="supportURL: ${escapeHTML(
               script.meta.supportURL
            )}" target="_blank" rel="noopener noreferrer" class="support-link">
      <svg width="20" height="20"><use xlink:href="#iconInfo"></use></svg>
   </a>`
            : '';

      const { registrationError, permissionError, anomalies } = script.state ?? {};
      let errorIndicatorHtml = '';

      if (registrationError || (anomalies && anomalies.length > 0)) {
         // Priority #1: Critical execution error (@require or syntax error)
         errorIndicatorHtml = this.#renderErrorIndicator(script);
      } else if (permissionError && !script.enabled) {
         // Priority #2: Missing host permissions
         errorIndicatorHtml = `<span class="error-indicator" title="${escapeHTML(
            i18n('opt_tooltip_permissions_needed')
         )}">🔒</span>`;
      }

      const isNewlyUpdated = script.state?.highlightUpdate;
      const classes = ['item'];
      if (script.id === this.#selectedScriptId) classes.push('selected');
      if (isNewlyUpdated) classes.push('is-newly-updated');
      if (registrationError) classes.push('error');
      if (script.isCloudOnly) classes.push('is-cloud-only');
      const itemClasses = classes.join(' ');

      const syncInfo = this.#syncStatusMap ? this.#syncStatusMap.get(script.isCloudOnly ? script.uuid : script.id) : null;
      const cloudFileId = syncInfo?.cloudFileId || script.cloudFileId || '';

      return `
         <li class="${itemClasses}" data-script-id="${script.id}" data-uuid="${script.uuid}" data-cloud-id="${cloudFileId}">
            <span class="script-type-icon">${errorIndicatorHtml || iconHtml}</span>

            <div class="script-main-info">
               <label for="script-toggle-${script.id}" class="script-label" title="${escapedNameAttr}" tooltip="${escapedNameAttr}">${highlightedName}</label>
               <div class="script-meta">
                  <span class="author-name">${authorHtml || (script.isCloudOnly ? 'Cloud Storage' : '')}</span>
                  ${supportLink}
               </div>
            </div>

            <div class="script-actions">
               <div class="script-meta-secondary">
                  ${versionHtml}
                  ${script.updatedAt
            ? `<span class="date" title="Last Updated">${this.#timeFormatter.formatTimeAgo(
               script.updatedAt
            )}</span>`
            : ''
         }
            ${script.size ? `<span class="size" title="Size">${this.#formatBytes(script.size)}</span>` : ''}
               </div>
               <div class="script-controls">
               ${!script.isCloudOnly
            ? `
                  <input type="checkbox" data-prop="enabled" class="script-enable" id="script-toggle-${script.id
            }" ${script.enabled ? 'checked' : ''}>
                  <input type="checkbox" data-prop="muteLogs" class="script-mute default-checkbox" title="${muteTooltip}" ${isMuteChecked ? 'checked' : ''
            } ${isMuteDisabled ? 'disabled' : ''}>
                  `
            : ''
         }

               ${gdriveHtml}

                  ${!script.isCloudOnly
            ? `
                     <span class="script-remove-btn" tooltip="${escapeHTML(i18n('tooltip_remove_script'))}" flow="left">
                        <svg width="20" height="20"><use xlink:href="#iconRemove"/></svg>
                     </span>
                  `
            : ''
         }
               </div>
            </div>
         </li>`;
   }

   /**
    * Formats numeric byte sizes into human-readable strings.
    * @private
    * @param {number} bytes
    * @param {number} [decimals=2]
    * @returns {string}
    */
   #formatBytes(bytes, decimals = 2) {
      if (!bytes || bytes === 0) return '0 Bytes';
      const k = 1024;
      const dm = decimals < 0 ? 0 : decimals;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
   }

   /**
    * Binds event listeners for search input, sorting, and delegated clicks.
    * @private
    */
   #attachListeners() {
      if (this.#searchInput) {
         this.#searchInput.addEventListener('input', ({ target }) => {
            this.#currentFilter = target.value;
            clearTimeout(this.#searchDebounceTimeout);
            this.#searchDebounceTimeout = setTimeout(() => {
               this.#updateListView();
            }, 150);
         });
      }

      if (this.#clearSearchBtn) {
         this.#clearSearchBtn.addEventListener('click', () => {
            this.#searchInput.value = '';
            clearTimeout(this.#searchDebounceTimeout);
            this.#currentFilter = '';
            this.#updateListView();
            this.#searchInput.focus();
         });
      }

      if (this.#sortSelect) {
         this.#sortSelect.addEventListener('change', ({ target }) => {
            this.#sortMode = target.value;
            browser.storage?.local?.set({ sortMode: target.value }).catch((err) => {
               console.warn('ScriptListManager: Failed to save sortMode', err);
            });
            this.#updateListView();
         });
      }

      // Delegated click handling on list container
      this.#element.addEventListener('click', (evt) => {
         const item = evt.target.closest('.item');
         if (!item) return;

         const isVirtual = item.classList.contains('is-cloud-only');
         const scriptId = isVirtual ? item.dataset.scriptId : Number(item.dataset.scriptId);

         // Google Drive action button click
         if (evt.target.closest('.gdrive-action-btn')) {
            evt.stopPropagation();
            const btn = evt.target.closest('.gdrive-action-btn');
            const action = btn.dataset.action;

            const cloudFileId = item.dataset.cloudId;
            const uuid = item.dataset.uuid;

            this.#element.dispatchEvent(
               new CustomEvent('gdriveAction', {
                  detail: {
                     scriptId,
                     cloudFileId,
                     uuid,
                     action,
                     eventTarget: evt.target,
                  },
                  bubbles: true,
               })
            );
            return;
         }

         // Action click routing
         if (evt.target.closest('.script-remove-btn')) {
            evt.stopPropagation();
            this.#element.dispatchEvent(new CustomEvent('scriptRemoved', { detail: { scriptId }, bubbles: true }));
         } else if (evt.target.matches('.require-error[data-retry-id]')) {
            evt.stopPropagation();
            this.#element.dispatchEvent(new CustomEvent('retryRequire', { detail: { scriptId }, bubbles: true }));
         } else if (evt.target.matches('.script-label')) {
            evt.preventDefault(); // Prevent native label checkbox toggling

            // Prevent opening virtual cloud scripts in the editor (they don't exist locally yet)
            if (!isVirtual) {
               this.#element.dispatchEvent(new CustomEvent('scriptSelected', { detail: { scriptId }, bubbles: true }));
            }
         } else if (!evt.target.matches('input[type="checkbox"]')) {
            // Same protection for general item area clicks
            if (!isVirtual) {
               this.#element.dispatchEvent(new CustomEvent('scriptSelected', { detail: { scriptId }, bubbles: true }));
            }
         }
      });

      // Delegated checkbox change handling (enable / mute logs)
      this.#element.addEventListener('change', (evt) => {
         if (!evt.target.matches('.script-enable, .script-mute')) return;
         const item = evt.target.closest('.item');
         if (!item) return;

         const scriptId = Number(item.dataset.scriptId);
         const prop = evt.target.dataset.prop;
         const value = evt.target.checked;

         this.#element.dispatchEvent(
            new CustomEvent('scriptToggled', {
               detail: { scriptId, prop, value },
               bubbles: true,
            })
         );
      });
   }

   /**
    * Initializes Sortable.js drag-and-drop reordering.
    * @private
    */
   #initSortable() {
      if (typeof Sortable === 'undefined') {
         console.warn('Sortable.js library not found. Drag-and-drop reordering will be disabled.');
         return;
      }

      this.#sortableInstance = Sortable.create(this.#element, {
         animation: 150,
         draggable: '.item',
         filter: 'input, button, a, .gdrive-action-btn, .script-remove-btn',
         preventOnFilter: false,
         onEnd: () => {
            const domItems = Array.from(this.#element.querySelectorAll('.item[data-script-id]'));
            const newOrderIds = domItems.map((el) => Number(el.dataset.scriptId)).filter(Boolean);

            const scriptMap = new Map(this.#scripts.map((s) => [s.id, s]));
            const reordered = [];

            newOrderIds.forEach((id, idx) => {
               const script = scriptMap.get(id);
               if (script) {
                  script.position = idx;
                  reordered.push(script);
                  scriptMap.delete(id);
               }
            });

            for (const script of scriptMap.values()) {
               reordered.push(script);
            }

            this.#scripts = reordered;
            this.#element.dispatchEvent(
               new CustomEvent('scriptsReordered', {
                  detail: { scripts: this.#scripts },
                  bubbles: true,
               })
            );
         },
      });
   }

   /**
    * Highlights matching search filter keywords in HTML text.
    * @private
    * @param {string} text
    * @param {string} keyword
    * @returns {string}
    */
   #highlightText(text, keyword) {
      if (!keyword || !text) return text;
      const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${safeKeyword})`, 'gi');
      return text.replace(regex, '<mark>$1</mark>');
   }

   /**
    * Formats script author name and email link.
    * @private
    * @param {string|Array|number} authorInput
    * @returns {string}
    */
   #createAuthorHTML(authorInput) {
      if (!authorInput) return '';

      // Convert to string: if array (multiple @author directives), join with commas
      const authorString = Array.isArray(authorInput)
         ? authorInput.join(', ')
         : String(authorInput); // Safely coerce any value type to string

      const authorRegex = /^\s*([^<]*?)\s*(?:<([^>]+)>)?\s*$/;
      const match = authorString.match(authorRegex);

      if (!match) return escapeHTML(authorString);

      const name = escapeHTML(match[1].trim());
      const rawEmail = match[2] ? match[2].trim() : '';
      const emailAttr = escapeHTML(rawEmail);

      return rawEmail
         ? `<a href="mailto:${emailAttr}" target="_blank" rel="noopener noreferrer" title="Email ${escapeHTML(match[1].trim() || rawEmail)}">${name || escapeHTML(rawEmail)}</a>`
         : name;
   }

   /**
    * Renders error or anomaly warning indicators for a script item.
    * @private
    * @param {Object} script
    * @returns {string}
    */
   #renderErrorIndicator(script) {
      const { registrationError, anomalies } = script.state ?? {};

      if (!registrationError && (!anomalies || anomalies.length === 0)) return '';

      if (registrationError) {
         const isRequireError = registrationError.includes('Failed to load dependency');
         const baseTitle = `Error: ${escapeHTML(registrationError)}`;
         const errorTitle = isRequireError ? `${baseTitle}\nClick to retry.` : baseTitle;

         return `<span class="error-indicator ${isRequireError ? 'require-error' : ''}" title="${escapeHTML(
            errorTitle
         )}" data-retry-id="${script.id}">⚠️</span>`;
      }

      if (anomalies && anomalies.length > 0) {
         const anomalyDescriptions = {
            new_eval_detected:
               'Warning: Dynamic code execution (eval) was introduced in the latest update of this script.',
            eval_detected:
               'Warning: This script utilizes dynamic execution (eval/Function) which could be a security risk.',
            high_obfuscation_risk: 'Warning: Extreme code obfuscation detected. Source analysis is difficult.',
         };

         const title = anomalies
            .map((key) => anomalyDescriptions[key] || `Warning: Suspicious code pattern detected (${key})`)
            .join('\n');

         return `<span class="error-indicator anomaly-warning" title="${escapeHTML(
            title
         )}" style="color: #FFC107; cursor: help;">⚠️</span>`;
      }

      return '';
   }
}
