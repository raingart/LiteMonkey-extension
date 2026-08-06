import browser from '../libs/browser-support.js';
import { i18n } from '../libs/localization.js';
import { ErrorCollector } from '../libs/error-collector.js';
import { MSG } from '../message-types.js';
import { logger } from '../libs/logger.js';
import { SettingsManager } from './options/settings-manager.js';
import { ScriptListManager } from './options/script-list-manager.js';
import { ScriptEditorManager } from './options/script-editor-manager.js';
import { MetadataParser } from '../libs/meta-parser.js';
import { sendMessageWithRetry } from '../libs/message-service.js';

const CONTEXT = 'OptionsPageController';

/**
 * Controller managing UI interactions, script management, settings,
 * import/export, and Google Drive cloud synchronization for the Options page.
 */
class OptionsPageController {
   #scripts = [];
   #selectedScriptId = null;

   /** @type {Map<number|string, { status: string, cloudFileId?: string }>|null} */
   #gdriveStatusMap = null;

   /** @type {boolean} Mutex flag preventing concurrent Google Drive operations */
   #isGDriveActionRunning = false;

   /** @type {number} Counter tracking active drag enter/leave events to prevent overlay flickering */
   #dragCounter = 0;

   #elements;
   #settingsManager;
   #scriptListManager;
   #scriptEditorManager;
   #toastTimeout;
   #initialEditorMode;

   constructor() {
      this.#elements = this.#queryElements();
      this.#init();
   }

   /**
    * Initializes page components, settings, managers, and performs initial data loading.
    * @private
    */
   async #init() {
      this.#initEventListeners();
      this.#initCollapsibleStorage();

      // 1. Load settings first to determine which editor implementation to instantiate.
      const { extension_settings = {} } = await browser.storage.sync.get('extension_settings');

      this.#initialEditorMode = extension_settings.editorMode || 'codemirror';
      const useSimpleEditor = this.#initialEditorMode === 'textarea';

      // 2. Initialize manager components.
      this.#settingsManager = new SettingsManager('#settings-form');
      this.#scriptEditorManager = new ScriptEditorManager('.editor form', useSimpleEditor);
      this.#scriptListManager = new ScriptListManager({
         list: '#script-list',
         search: '#script-search',
         sort: '#script-sort',
         clearSearch: '#clear-script-search-btn',
      });

      await this.#settingsManager.init(() => {
         this.#showToast(i18n('toast_settings_saved'), 'success');
         const settingsForm = document.querySelector('#settings-form');
         const newEditorMode = settingsForm.elements.editorMode.value;
         if (newEditorMode !== this.#initialEditorMode) {
            if (confirm('Editor settings have changed. Reload the page to apply them?')) {
               location.reload();
            }
            // Update initial mode reference in case settings are saved again without page reload
            this.#initialEditorMode = newEditorMode;
         }
      });

      // 3. Load initial scripts and evaluate URL parameters or pending installations.
      await this.#loadAndRenderScripts();
      const wasHandledByUrl = await this.#handleUrlParameters();
      if (!wasHandledByUrl) {
         this.#handleClearEditor();
      }
      this.#checkForPendingInstall();
      this.#refreshGDriveStatus(); // Silent background status refresh
   }

   /**
    * Queries and caches essential DOM element references.
    * @private
    * @returns {Record<string, HTMLElement|null>}
    */
   #queryElements() {
      const selectors = {
         container: '.container',
         scriptImportBtn: '#scripts-import',
         scriptExportBtn: '#scripts-export',
         settingsBtn: '#settings-btn',
         scriptNewBtn: '#script-new-btn',
         checkUpdatesBtn: '#check-updates-btn',
         form: '.editor form',
         storagePanel: '.panel.storage',
         storageToggle: '#storage-toggle',
         dropZone: '#drop-zone',
      };
      return Object.fromEntries(
         Object.entries(selectors).map(([key, selector]) => [key, document.querySelector(selector)])
      );
   }

   /**
    * Binds global window, UI element, and child component events.
    * @private
    */
   #initEventListeners() {
      const {
         container,
         scriptImportBtn,
         scriptExportBtn,
         settingsBtn,
         checkUpdatesBtn,
         scriptNewBtn,
         form,
         storageToggle,
         dropZone,
      } = this.#elements;

      // Listen for custom bubbling events from manager components
      container.addEventListener('scriptSelected', (e) => this.#handleScriptSelected(e.detail.scriptId));
      container.addEventListener('scriptToggled', (e) =>
         this.#updateScriptProperty(e.detail.scriptId, e.detail.prop, e.detail.value)
      );
      container.addEventListener('scriptRemoved', (e) => this.#handleRemoveScript(e.detail.scriptId));
      container.addEventListener('scriptsReordered', (e) => this.#onDragEnd(e.detail.scripts));
      container.addEventListener('retryRequire', (e) => this.#retryRequireDependencies(e.detail.scriptId));
      container.addEventListener('themeChanged', (e) => this.#setTheme(e.detail.theme));
      container.addEventListener('globalSettingsChanged', (e) => {
         this.#scriptListManager.render(this.#scripts, this.#selectedScriptId, e.detail.muteAllLogs);
      });

      // Global action button triggers
      scriptImportBtn.addEventListener('click', () => this.#handleImport());
      scriptExportBtn.addEventListener('click', () => this.#handleExport());
      settingsBtn.addEventListener('click', () => this.#toggleSettingsMode());
      checkUpdatesBtn.addEventListener('click', () => this.#handleCheckUpdates());
      scriptNewBtn.addEventListener('click', () => this.#handleClearEditor());

      const gdriveSyncBtn = document.querySelector('#gdrive-sync-btn');
      if (gdriveSyncBtn) {
         gdriveSyncBtn.addEventListener('click', () => this.#handleGDriveSyncClick());
      }

      container.addEventListener('gdriveAction', (e) => this.#handleGDriveAction(e.detail));

      // Editor form events
      form.addEventListener('submit', (e) => this.#handleSaveScript(e));
      form.addEventListener('editorDirtyStateChange', (e) => {
         document.querySelector('.item.selected')?.classList.toggle('unsaved', e.detail.isDirty);
      });

      // Storage panel collapsible toggle
      if (storageToggle) {
         storageToggle.addEventListener('click', () => {
            this.#elements.storagePanel.classList.toggle('is-collapsed');
         });
      }

      // Drag-and-Drop (DND) import handlers
      window.addEventListener('dragenter', (e) => {
         e.preventDefault();
         this.#dragCounter++;
         if (this.#dragCounter === 1 && dropZone) {
            dropZone.classList.remove('hide');
         }
      });

      window.addEventListener('dragover', (e) => {
         e.preventDefault(); // Necessary to allow native drop
      });

      window.addEventListener('dragleave', (e) => {
         e.preventDefault();
         this.#dragCounter--;
         if (this.#dragCounter === 0 && dropZone) {
            dropZone.classList.add('hide');
         }
      });

      window.addEventListener('drop', async (e) => {
         e.preventDefault();
         this.#dragCounter = 0;
         if (dropZone) {
            dropZone.classList.add('hide');
         }

         const files = Array.from(e.dataTransfer?.files || []);
         if (files.length > 0) {
            await this.#processImportFiles(files);
         }
      });

      // Unified window beforeunload event checking BOTH script editor and settings form dirty states
      window.addEventListener('beforeunload', (e) => {
         const isEditorDirty = this.#scriptEditorManager?.hasUnsavedChanges();
         const isSettingsDirty = this.#settingsManager?.isDirty; // Add getter in settings manager if needed

         if (isEditorDirty || isSettingsDirty) {
            e.preventDefault();
            e.returnValue = i18n('opt_confirm_discard_unsaved');
            return e.returnValue;
         }
      });

      // Global keyboard shortcuts and window events
      window.addEventListener('resize', () => this.#initCollapsibleStorage());
      window.addEventListener(
         'keydown',
         (e) => {
            const isCtrlS = (e.ctrlKey || e.metaKey) && e.code === 'KeyS';

            if (isCtrlS && !container.classList.contains('settings-mode')) {
               e.preventDefault();
               form.querySelector('button[type="submit"]')?.click();
            }
         },
         true
      );
   }

   /**
    * Automatically collapses the storage panel on narrower viewports.
    * @private
    */
   #initCollapsibleStorage() {
      this.#elements.storagePanel.classList.toggle('is-collapsed', window.innerWidth <= 1400);
   }

   /**
    * Fetches the script list from the background worker and updates the UI.
    * @private
    */
   async #loadAndRenderScripts() {
      const { scripts = [] } = await sendMessageWithRetry({ type: MSG.GET_ALL_SCRIPTS });
      const { extension_settings = {} } = await browser.storage.sync.get('extension_settings');
      this.#scripts = scripts;

      this.#scriptListManager.render(this.#scripts, this.#selectedScriptId, !!extension_settings.muteAllLogs);
   }

   /**
    * Selects a script, fetches its source code, and loads it into the editor.
    * @private
    * @param {number} scriptId
    */
   async #handleScriptSelected(scriptId) {
      if (this.#scriptEditorManager.hasUnsavedChanges()) {
         if (!confirm(i18n('opt_confirm_discard_unsaved'))) return;
      }

      const selectedScript = this.#scripts.find((s) => s.id === scriptId);
      if (selectedScript?.state?.highlightUpdate) {
         const updatedState = { ...selectedScript.state, highlightUpdate: false };
         delete updatedState.previousVersion;

         await sendMessageWithRetry({
            type: MSG.UPDATE_SCRIPT_PROPS,
            payload: { scriptId, props: { state: { ...selectedScript.state, highlightUpdate: false } } },
         });

         selectedScript.state = updatedState;
         this.#scriptListManager.render(this.#scripts, this.#selectedScriptId, false);
      }

      this.#selectedScriptId = scriptId;
      this.#scriptListManager.updateSelection(scriptId);

      const { script } = await sendMessageWithRetry({
         type: MSG.GET_SCRIPT_WITH_CODE,
         payload: { scriptId },
      });

      // Guard against race conditions caused by rapid sequential selection changes
      if (this.#selectedScriptId !== scriptId) return;

      if (script) {
         const syncInfo = this.#gdriveStatusMap?.get(scriptId);
         const isSynced = syncInfo && syncInfo.status !== 'not_synced' && syncInfo.status !== 'cloud_only';

         this.#scriptEditorManager.loadScript(script, isSynced);
      }

      if (this.#elements.container.classList.contains('settings-mode')) {
         this.#toggleSettingsMode();
      }
   }

   /**
    * Resets the editor state for creating a new script.
    * @private
    */
   #handleClearEditor() {
      if (this.#scriptEditorManager.hasUnsavedChanges()) {
         if (!confirm(i18n('opt_confirm_discard_unsaved'))) {
            return;
         }
      }
      this.#selectedScriptId = null;
      this.#scriptListManager.updateSelection(null);
      this.#scriptEditorManager.clear();
      if (this.#elements.container.classList.contains('settings-mode')) {
         this.#toggleSettingsMode();
      }
   }

   /**
    * Triggers saving from the script editor manager and notifies user.
    * @private
    * @param {SubmitEvent} e
    */
   async #handleSaveScript(e) {
      e.preventDefault();
      const result = await this.#scriptEditorManager.save();

      if (result?.success) {
         await this.#onSaveSuccess(result.script);
         if (result.warning) {
            this.#showToast(result.warning, 'warning');
         }
      } else if (result?.error) {
         this.#showToast(result.error, 'error');
      }
   }

   /**
    * Post-save handler to refresh list and active script state.
    * @private
    * @param {Object} savedScript
    */
   async #onSaveSuccess(savedScript) {
      if (!savedScript) return;
      this.#showToast(i18n('toast_script_saved'));
      this.#selectedScriptId = savedScript.id;
      await this.#loadAndRenderScripts();
   }

   /**
    * Removes a script by ID after confirmation.
    * @private
    * @param {number} scriptId
    */
   async #handleRemoveScript(scriptId) {
      if (!confirm(i18n('opt_script_remove_confirm'))) return;
      await sendMessageWithRetry({ type: MSG.DELETE_SCRIPT, payload: { scriptId } });
      if (this.#selectedScriptId === scriptId) {
         this.#handleClearEditor();
      }
      await this.#loadAndRenderScripts();
      this.#showToast(i18n('toast_script_removed'));
   }

   /**
    * Toggles or updates a script setting property, requesting missing host permissions if required.
    * @private
    * @param {number} scriptId
    * @param {string} prop
    * @param {*} value
    */
   async #updateScriptProperty(scriptId, prop, value) {
      const script = this.#scripts.find((s) => s.id === scriptId);
      if (!script) return;

      const isTopLevelProp = prop === 'enabled';
      const originalValue = isTopLevelProp ? script[prop] : script.config?.[prop];
      if (originalValue === value) return;

      const propsToUpdate = isTopLevelProp ? { [prop]: value } : { config: { ...script.config, [prop]: value } };

      const message = { type: MSG.UPDATE_SCRIPT_PROPS, payload: { scriptId, props: propsToUpdate } };
      const response = await sendMessageWithRetry(message);

      if (response?.needsPermissions) {
         try {
            const granted = await browser.permissions.request(response.details);
            if (granted) {
               const finalResponse = await sendMessageWithRetry(message);
               if (finalResponse?.success) {
                  await this.#loadAndRenderScripts();
                  this.#showToast(i18n('toast_permissions_granted'), 'success');
               } else {
                  this.#showToast(finalResponse?.error || 'Failed to save after granting permissions.', 'error');
                  this.#scriptListManager.revertToggleState(scriptId, prop, originalValue);
               }
            } else {
               this.#showToast(i18n('toast_enable_failed_permission'), 'warning');
               this.#scriptListManager.revertToggleState(scriptId, prop, originalValue);
            }
         } catch (err) {
            logger.error(CONTEXT, 'Error during permissions.request invocation:', err);
            this.#showToast('An unexpected error occurred while requesting permissions.', 'error');
            this.#scriptListManager.revertToggleState(scriptId, prop, originalValue);
         }
      } else if (response?.success) {
         await this.#loadAndRenderScripts();
         this.#showToast(i18n('toast_script_saved'));
      } else {
         this.#showToast(response?.error || 'Unknown error', 'error');
         this.#scriptListManager.revertToggleState(scriptId, prop, originalValue);
      }
   }

   /**
    * Persists newly reordered scripts list.
    * @private
    * @param {Array<Object>} reorderedScripts
    */
   async #onDragEnd(reorderedScripts) {
      this.#scripts = reorderedScripts;
      await sendMessageWithRetry({ type: MSG.REORDER_SCRIPTS, payload: { scripts: this.#scripts } });
      this.#showToast(i18n('toast_order_saved'));
   }

   /**
    * Processes query parameters in URL to open or import scripts directly.
    * @private
    * @returns {Promise<boolean>} True if URL parameter action was taken.
    */
   async #handleUrlParameters() {
      const params = new URLSearchParams(window.location.search);
      const scriptIdToOpen = params.get('scriptId');
      const newScriptUrl = params.get('new_script_url');

      if (newScriptUrl) {
         this.#scriptEditorManager.loadNewScriptTemplate(newScriptUrl);
         return true;
      }

      if (scriptIdToOpen) {
         const scriptId = parseInt(scriptIdToOpen, 10);
         if (this.#scripts.some((s) => s.id === scriptId)) {
            await this.#handleScriptSelected(scriptId);
            return true;
         }
      }
      return false;
   }

   /**
    * Toggles options settings view mode.
    * @private
    */
   #toggleSettingsMode() {
      this.#elements.container.classList.toggle('settings-mode');
      this.#elements.settingsBtn.classList.toggle('active');
   }

   /**
    * Applies selected or OS-preferred color theme to document root element.
    * @private
    * @param {string} theme
    */
   #setTheme(theme) {
      let themeToApply = theme;

      if (theme === 'auto') {
         const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
         themeToApply = prefersDark ? 'dark-gray' : 'light';
      }

      document.documentElement.dataset.theme = themeToApply;
   }

   /**
    * Initiates manual check for script updates.
    * @private
    */
   async #handleCheckUpdates() {
      const btn = this.#elements.checkUpdatesBtn;
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.textContent = i18n('opt_btn_checking_updates');

      try {
         const summary = await sendMessageWithRetry({ type: MSG.CHECK_SCRIPTS_UPDATES });
         if (summary.inProgress) {
            this.#showToast(i18n('toast_update_in_progress'), 'warning');
         } else if (summary.updated > 0) {
            this.#showToast(i18n('toast_updates_found', [summary.updated]), 'success');
            await this.#loadAndRenderScripts();

            if (this.#selectedScriptId && summary.updatedIds?.includes(this.#selectedScriptId)) {
               if (this.#scriptEditorManager.hasUnsavedChanges()) {
                  alert(i18n('opt_alert_editor_conflict_update'));
               } else {
                  await this.#handleScriptSelected(this.#selectedScriptId);
                  this.#showToast(
                     i18n('toast_editor_reloaded_update') || 'Editor reloaded with the updated code.',
                     'info'
                  );
               }
            }
         } else {
            this.#showToast(i18n('toast_no_updates'), 'info');
         }
      } catch (err) {
         this.#showToast(i18n('toast_updates_failed'), 'error');
      } finally {
         btn.disabled = false;
         btn.classList.remove('is-loading');
         btn.textContent = i18n('opt_btn_check_updates');
      }
   }

   /**
    * Checks session storage for pending script installation data from external web navigations.
    * @private
    */
   async #checkForPendingInstall() {
      const { pending_script_install } = await browser.storage.session.get('pending_script_install');
      if (!pending_script_install) return;

      await browser.storage.session.remove('pending_script_install');

      // Load pending install into editor without programmatic form.submit dispatch.
      // Requires explicit user click on Save button to satisfy Chrome's User Gesture requirement for permissions.request()
      this.#scriptEditorManager.loadPendingInstall(pending_script_install);
      this.#showToast(i18n('toast_pending_install'), 'info');

      // Highlight save button visually to guide user click
      const saveBtn = document.querySelector('.editor form button[type="submit"]');
      if (saveBtn) {
         saveBtn.focus();
         saveBtn.classList.add('pulse-highlight');
      }
   }

   /**
    * Creates file picker element to select scripts or backup files to import.
    * @private
    */
   async #handleImport() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json,.js,.user.js,.css,.user.css';
      input.multiple = true;

      input.onchange = async ({ target }) => {
         const files = Array.from(target.files);
         if (!files.length) return;
         await this.#processImportFiles(files);
      };
      input.click();
   }

   /**
    * Parses JSON backups or script files and sends parsed payload to background importer.
    * @private
    * @param {File[]} files
    */
   async #processImportFiles(files) {
      try {
         const scriptsToImport = [];
         let settingsImported = false;

         for (const file of files) {
            const content = await file.text();

            if (file.name.endsWith('.json')) {
               const data = JSON.parse(content);
               if (!data || typeof data !== 'object' || Array.isArray(data)) {
                  throw new Error('Invalid backup format.');
               }
               if (data.settings && typeof data.settings === 'object') {
                  await browser.storage.sync.set({ extension_settings: data.settings });
                  settingsImported = true;
               }

               const backupScripts = data.scripts;
               if (!Array.isArray(backupScripts)) continue;

               for (const script of backupScripts) {
                  if (!script.userCode) continue;

                  // Extract parsed meta and type from script.userCode (falling back to script properties)
                  const parsed = MetadataParser.parse(script.userCode);
                  const meta = parsed.meta?.name ? parsed.meta : (script.meta || {});
                  const type = parsed.type || script.type || 'userscript';

                  if (!meta || !meta.name) {
                     throw new Error(i18n('installer_error_no_meta') || 'Invalid userscript (missing @name)');
                  }
                  scriptsToImport.push({
                     userCode: script.userCode,
                     meta,
                     type,
                     config: script.config || {},
                     storage: script.storage || {},
                     wasEnabled: script.enabled ?? true,
                     position: script.position ?? Date.now(),
                  });
               }
            } else {
               const { meta } = MetadataParser.parse(content);
               if (!meta || !meta.name) {
                  throw new Error(i18n('installer_error_no_meta') || 'Invalid userscript (missing @name)');
               }
               scriptsToImport.push({
                  userCode: content,
                  meta,
                  wasEnabled: true,
                  position: Date.now(),
               });
            }
         }

         if (scriptsToImport.length) {
            await sendMessageWithRetry({ type: MSG.IMPORT_SCRIPTS, payload: { scripts: scriptsToImport } });
         }

         // Refresh total UI state
         await this.#loadAndRenderScripts();
         if (settingsImported) await this.#settingsManager.load();

         if (this.#selectedScriptId) {
            const stillExists = this.#scripts.some((s) => s.id === this.#selectedScriptId);
            if (stillExists) {
               await this.#handleScriptSelected(this.#selectedScriptId);
            } else {
               this.#handleClearEditor();
            }
         }

         this.#showToast(i18n('toast_import_completed'), 'success');
      } catch (err) {
         logger.error(CONTEXT, 'Import failed:', err);
         ErrorCollector.captureAndReport(err, { trace_name: '#processImportFiles' });
         this.#showToast(`${i18n('opt_alert_import_failed')} ${err.message}`, 'error');
      }
   }

   /**
    * Generates and downloads a JSON export backup of settings, scripts, and GM storage.
    * @private
    */
   async #handleExport() {
      try {
         const [{ scripts: allScripts = [] }, { extension_settings = {} }] = await Promise.all([
            sendMessageWithRetry({ type: MSG.GET_ALL_SCRIPTS_WITH_CODE }),
            browser.storage.sync.get('extension_settings'),
         ]);

         const scriptsForExport = await Promise.all(
            allScripts.map(async (script) => {
               const { id, iconDataUrl, state = {}, ...rest } = script;

               // Strip transient local diagnostic state flags prior to exporting backup JSON
               const { lastUpdateError, highlightUpdate, previousVersion, ...cleanState } = state;

               let storageValue = {};
               try {
                  const storageRes = await sendMessageWithRetry({
                     type: MSG.GM_GET_FULL_STORAGE,
                     payload: { scriptId: id },
                  });
                  storageValue = storageRes?.value || {};
               } catch (err) {
                  logger.warn(CONTEXT, `Failed to export storage for script ${id}:`, err);
               }

               return {
                  ...rest,
                  state: cleanState,
                  storage: storageValue,
               };
            })
         );

         const exportData = {
            version: 1,
            timestamp: new Date().toISOString(),
            settings: extension_settings || {},
            scripts: scriptsForExport,
         };

         const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
         const url = URL.createObjectURL(blob);
         const a = document.createElement('a');
         a.href = url;
         a.download = `lite_monkey_backup_${new Date().toISOString().split('T')[0]}.json`;
         document.body.appendChild(a);
         a.click();
         document.body.removeChild(a);
         URL.revokeObjectURL(url);
      } catch (err) {
         logger.error(CONTEXT, 'Export failed:', err);
         ErrorCollector.captureAndReport(err, { trace_name: '#handleExport' });
         this.#showToast('Export failed. See console for details', 'error');
      }
   }

   /**
    * Retries downloading external script dependencies (@require / @resource).
    * @private
    * @param {number} scriptId
    */
   async #retryRequireDependencies(scriptId) {
      try {
         this.#showToast(i18n('toast_require_retry_started'));
         const { script: fullScript } = await sendMessageWithRetry({
            type: MSG.GET_SCRIPT_WITH_CODE,
            payload: { scriptId },
         });
         if (fullScript) {
            const response = await sendMessageWithRetry({
               type: MSG.SAVE_SCRIPT,
               payload: { scriptObject: fullScript },
            });
            await this.#loadAndRenderScripts();
            if (response.success) {
               this.#showToast(i18n('toast_require_retry_success'), 'success');
               if (this.#selectedScriptId === scriptId) {
                  await this.#handleScriptSelected(scriptId);
               }
            } else {
               this.#showToast(response.error || i18n('toast_require_retry_failed'), 'error');
            }
         }
      } catch (err) {
         logger.error(CONTEXT, `Failed to retry @require for script ${scriptId}:`, err);
         ErrorCollector.captureAndReport(err, { trace_name: '#retryRequireDependencies' });
         this.#showToast('An error occurred while retrying dependencies.', 'error');
      }
   }

   /**
    * Displays temporary notification toast message.
    * @private
    * @param {string} message
    * @param {'info'|'success'|'warning'|'error'} [type='info']
    */
   #showToast(message, type = 'info') {
      const toast = document.getElementById('toast-notification');
      if (!toast) return;
      toast.textContent = message;
      toast.className = `toast show toast--${type}`;
      clearTimeout(this.#toastTimeout);
      this.#toastTimeout = setTimeout(() => toast.classList.remove('show'), 2800);
   }

   /**
    * Global Google Drive sync handler. Requests identity permission if missing.
    * @private
    */
   async #handleGDriveSyncClick() {
      const btn = document.querySelector('#gdrive-sync-btn');

      if (!btn || btn.disabled || this.#isGDriveActionRunning) return;

      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.textContent = i18n('opt_btn_gdrive_sync_process') || 'Syncing...';
      this.#isGDriveActionRunning = true;

      try {
         // Check for identity API permission
         const hasPermission = await browser.permissions.contains({ permissions: ['identity'] });

         if (!hasPermission) {
            const granted = await browser.permissions.request({ permissions: ['identity'] });
            if (!granted) {
               this.#showToast(i18n('toast_gdrive_permission_denied'), 'warning');
               return;
            }
         }

         this.#showToast(i18n('toast_gdrive_sync_started'), 'info');

         const response = await sendMessageWithRetry({
            type: MSG.GDRIVE_GET_STATUS,
            payload: { interactive: true },
         });

         if (response && response.success) {
            this.#gdriveStatusMap = new Map(response.statuses);
            this.#scriptListManager.setSyncStatuses(this.#gdriveStatusMap);
            this.#updateEditorSyncState();
            this.#showToast(i18n('toast_gdrive_sync_success'), 'success');
         } else {
            throw new Error(response?.error || 'Unknown error');
         }
      } catch (err) {
         logger.error(CONTEXT, 'Google Drive sync failed:', err);
         this.#showToast(i18n('toast_gdrive_sync_failed'), 'error');
      } finally {
         btn.disabled = false;
         btn.classList.remove('is-loading');
         btn.textContent = i18n('opt_btn_gdrive_sync');
         this.#isGDriveActionRunning = false;
      }
   }

   /**
    * Executes individual Google Drive operations for a single script (upload, download, delete).
    * @private
    * @param {Object} actionDetail
    * @param {number} actionDetail.scriptId
    * @param {string} actionDetail.cloudFileId
    * @param {string} actionDetail.uuid
    * @param {'upload'|'download'|'delete-cloud'} actionDetail.action
    * @param {HTMLElement} [actionDetail.eventTarget]
    */
   async #handleGDriveAction({ scriptId, cloudFileId, uuid, action, eventTarget }) {
      if (this.#isGDriveActionRunning) {
         logger.warn(CONTEXT, `GDrive action "${action}" ignored: another operation is in progress.`);
         return;
      }

      if (action === 'delete-cloud') {
         if (!confirm(i18n('opt_gdrive_delete_confirm'))) return;
      }

      const btn = eventTarget?.closest('.gdrive-action-btn');
      if (btn) {
         btn.disabled = true;
         btn.style.opacity = '0.3';
         btn.style.pointerEvents = 'none';
      }

      this.#isGDriveActionRunning = true;

      try {
         if (action === 'upload') {
            this.#showToast(i18n('toast_gdrive_uploading'), 'info');
            const response = await sendMessageWithRetry({ type: MSG.GDRIVE_UPLOAD, payload: { scriptId } });

            if (response?.success) {
               this.#showToast(i18n('toast_gdrive_upload_success'), 'success');

               // Optimistic UI update: mark script as synced locally
               if (this.#gdriveStatusMap) {
                  this.#gdriveStatusMap.set(scriptId, {
                     status: 'synced',
                     cloudFileId: response.cloudFileId,
                  });
                  this.#scriptListManager.setSyncStatuses(this.#gdriveStatusMap);
                  this.#updateEditorSyncState();
               }
            } else {
               throw new Error(response?.error);
            }
         } else if (action === 'download') {
            this.#showToast(i18n('toast_gdrive_downloading'), 'info');
            const response = await sendMessageWithRetry({ type: MSG.GDRIVE_DOWNLOAD, payload: { cloudFileId } });

            if (response?.success) {
               this.#showToast(i18n('toast_gdrive_download_success'), 'success');
               await this.#loadAndRenderScripts();

               // Optimistic UI update: convert virtual cloud entry to local synced script
               if (this.#gdriveStatusMap) {
                  const newScript = this.#scripts.find((s) => s.uuid === uuid);
                  if (newScript) {
                     this.#gdriveStatusMap.delete(uuid);
                     this.#gdriveStatusMap.set(newScript.id, { status: 'synced', cloudFileId });
                     this.#scriptListManager.setSyncStatuses(this.#gdriveStatusMap);
                     this.#updateEditorSyncState();
                  }
               }

               if (this.#selectedScriptId && this.#selectedScriptId === scriptId) {
                  await this.#handleScriptSelected(scriptId);
               }
            } else {
               throw new Error(response?.error);
            }
         } else if (action === 'delete-cloud') {
            this.#showToast(i18n('toast_gdrive_deleting'), 'info');
            const response = await sendMessageWithRetry({ type: MSG.GDRIVE_DELETE_CLOUD, payload: { cloudFileId } });

            if (response?.success) {
               this.#showToast(i18n('toast_gdrive_delete_success'), 'success');

               // Optimistic UI update: remove entry from status map
               if (this.#gdriveStatusMap) {
                  const keyToDelete = uuid || scriptId;
                  this.#gdriveStatusMap.delete(keyToDelete);
                  this.#scriptListManager.setSyncStatuses(this.#gdriveStatusMap);
                  this.#updateEditorSyncState();
               }
            } else {
               throw new Error(response?.error);
            }
         }
      } catch (err) {
         logger.error(CONTEXT, `Google Drive action failed: ${action}`, err);
         this.#showToast(i18n('toast_gdrive_action_failed'), 'error');
      } finally {
         this.#isGDriveActionRunning = false;
         if (btn) {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.pointerEvents = '';
         }
      }
   }

   /**
    * Synchronizes editor state indicator with current Google Drive status.
    * @private
    */
   #updateEditorSyncState() {
      if (!this.#selectedScriptId) return;

      const syncInfo = this.#gdriveStatusMap?.get(this.#selectedScriptId);
      const isSynced = syncInfo && syncInfo.status !== 'not_synced' && syncInfo.status !== 'cloud_only';

      this.#scriptEditorManager.setSyncState(isSynced);
   }

   /**
    * Background status check for updating Google Drive indicators across script list.
    * @private
    */
   async #refreshGDriveStatus() {
      const response = await sendMessageWithRetry({ type: MSG.GDRIVE_GET_STATUS }).catch(() => { });
      if (response && response.success) {
         this.#gdriveStatusMap = new Map(response.statuses);
         this.#scriptListManager.setSyncStatuses(this.#gdriveStatusMap);
         this.#updateEditorSyncState();
      }
   }
}

// Global unhandled error handlers
window.addEventListener('unhandledrejection', (e) =>
   ErrorCollector.captureAndReport(e.reason, { trace_name: 'unhandledRejection' })
);
window.addEventListener('error', (e) =>
   ErrorCollector.captureAndReport(e.error || e, { trace_name: 'windowError' })
);

// Initialize options page controller on DOM load
window.addEventListener('DOMContentLoaded', () => new OptionsPageController());
