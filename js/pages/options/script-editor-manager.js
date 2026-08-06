import browser from '../../libs/browser-support.js';
import { i18n } from '../../libs/localization.js';
import { logger } from '../../libs/logger.js';
import { MetadataParser } from '../../libs/meta-parser.js';
import { MatchPattern } from '../../libs/match-pattern.js';
import { MSG } from '../../message-types.js';
import { TextareaAdapter, CodeMirrorAdapter } from '../../ui/adapters/editor-adapters.js';
import { sendMessageWithRetry } from '../../libs/message-service.js';

const CONTEXT = 'ScriptEditorManager';

/** @type {Record<string, string>} Default code placeholders for new scripts/styles */
const PLACEHOLDERS = {
   userscript: `// ==UserScript==
// @name        New Script
// @match       https://www.example.com/*
// @version     1.0
// @author      -
// @grant       none
// ==/UserScript==`,
   userstyle: `/* ==UserStyle==
@name        New Style
@namespace   userstyles.world/user/example
@version     1.0.0
@description A new userstyle
@author      Me
==/UserStyle== */

@-moz-document domain("example.com") {
  body {
    background-color: #f0f0f0 !important;
  }
}`,
};

/** Safe JSON serialization and parsing helpers */
const tryJSON = {
   stringify: (obj, fallback = '/* Error */') => {
      try {
         return JSON.stringify(obj, null, 2);
      } catch {
         return fallback;
      }
   },
   parse: (str) => {
      try {
         const data = str.trim() ? JSON.parse(str) : {};
         return { success: true, data };
      } catch (err) {
         return { success: false, error: err.message };
      }
   },
};

/**
 * Manages the script code editor, GM storage editor, pattern testing, and save lifecycle.
 */
export class ScriptEditorManager {
   #form;
   #elements;
   #isDirty = false;
   #isCreatingNewScript = true;

   /** @type {boolean} Mutex flag preventing concurrent/overlapping saves */
   #isSaving = false;

   #editorAdapter = null;
   #storageAdapter = null;
   #currentScript = null;

   /** @type {number} Generation counter to prevent async race conditions when switching scripts rapidly */
   #loadGeneration = 0;

   #testDebounceTimeout = null; // Debounce timer for pattern tester execution

   /**
    * @param {string} formSelector DOM selector for the editor form
    * @param {boolean} useSimpleEditor Whether to use plain textarea instead of CodeMirror
    */
   constructor(formSelector, useSimpleEditor) {
      this.#form = document.querySelector(formSelector);
      if (!this.#form) {
         throw new Error(`ScriptEditorManager: Form element with selector '${formSelector}' not found.`);
      }

      this.#initializeElements();
      this.#setupEditor(useSimpleEditor);
      this.#setupStorageEditor(useSimpleEditor);
      this.#attachListeners();
   }

   // --- Public API ---

   /**
    * Loads an existing script into the editor and fetches its associated storage values.
    * @param {Object} script
    * @param {boolean} [isSynced=false]
    */
   async loadScript(script, isSynced = false) {
      const myGeneration = ++this.#loadGeneration;
      this.#isCreatingNewScript = false;
      this.#currentScript = script;

      const { scriptType, scriptUrls } = this.#elements;
      scriptType.value = script.type || 'userscript';
      scriptUrls.value = script.customUrls || '';

      // Fetch full storage payload in 1 atomic IPC roundtrip
      const { value: storageObject = {} } = await sendMessageWithRetry({
         type: MSG.GM_GET_FULL_STORAGE,
         payload: { scriptId: script.id },
      }).catch((err) => {
         logger.error(CONTEXT, 'Failed to fetch full storage payload:', err);
         return { value: {} };
      });

      // Abort if another script selection occurred while fetching storage asynchronously
      if (myGeneration !== this.#loadGeneration) return;

      if (this.#storageAdapter) {
         this.#storageAdapter.setValue(tryJSON.stringify(storageObject));
         this.#storageAdapter.setReadOnly(true); // Always lock storage editing by default on file load
      }

      if (this.#editorAdapter) {
         this.#editorAdapter.setValue(script.userCode || '');
         if (this.#editorAdapter instanceof CodeMirrorAdapter) {
            this.#editorAdapter.reconfigure(script.type || 'userscript');
         }
      }

      if (this.#elements.storageDataEditCheckbox) {
         this.#elements.storageDataEditCheckbox.checked = false;
      }

      this.setSyncState(isSynced);
      this.#updateStoragePanelState();
      this.#updateURLRulesPlaceholder();
      this.#updateTesterState();
      this.#handleTestUrlPatterns();
      this.#setDirty(false);
   }

   /**
    * Clears the editor state for creating a new script.
    */
   clear() {
      ++this.#loadGeneration; // Invalidate any in-flight asynchronous script loading tasks
      this.#isCreatingNewScript = true;
      this.#currentScript = null;
      this.#form.reset();

      if (this.#storageAdapter) {
         this.#storageAdapter.setValue('');
         this.#storageAdapter.setReadOnly(true);
      }

      if (this.#elements.storageDataEditCheckbox) {
         this.#elements.storageDataEditCheckbox.checked = false;
      }

      if (this.#editorAdapter) {
         const placeholder = PLACEHOLDERS[this.#elements.scriptType.value] || PLACEHOLDERS.userscript;
         this.#editorAdapter.setValue(placeholder);
      }

      this.#updateStoragePanelState();
      this.#updateURLRulesPlaceholder();
      this.#updateTesterState();
      this.#handleTestUrlPatterns();
      this.#setDirty(false);
   }

   /**
    * Loads a pending script installation payload (e.g., interrupted by permission prompts).
    * @param {Object} scriptObject
    */
   loadPendingInstall(scriptObject) {
      this.clear();
      this.#isCreatingNewScript = true; // Remains new until first successful save
      this.#currentScript = scriptObject;

      const { scriptType, scriptUrls } = this.#elements;
      scriptType.value = scriptObject.type || 'userscript';
      scriptUrls.value = scriptObject.customUrls || '';

      if (this.#storageAdapter) {
         this.#storageAdapter.setValue(tryJSON.stringify(scriptObject.storage));
      }

      if (this.#editorAdapter) {
         this.#editorAdapter.setValue(scriptObject.userCode || '');
         // Reconfigure CodeMirror syntax highlighting mode to match the pending script type
         if (this.#editorAdapter instanceof CodeMirrorAdapter) {
            this.#editorAdapter.reconfigure(scriptType.value);
         }
      }

      this.#updateStoragePanelState();
      this.#setDirty(true); // Mark dirty to enable save button
   }

   /**
    * Initializes a new script template populated with target URL match patterns.
    * @param {string} url
    */
   loadNewScriptTemplate(url) {
      this.clear();

      let matchRule = 'https://www.example.com/*';
      let scriptName = 'New Script';

      if (url) {
         try {
            const urlObject = new URL(url);
            const hostname = urlObject.hostname.startsWith('www.')
               ? urlObject.hostname.substring(4)
               : urlObject.hostname;

            matchRule = `*://${hostname}/*`;
            scriptName = `New Script for ${hostname}`;
         } catch (e) {
            // Fallback to default match rule if URL is invalid
         }
      }

      const placeholder = `// ==UserScript==
// @name        ${scriptName}
// @match       ${matchRule}
// @version     1.0
// @author      -
// @grant       none
// ==/UserScript==`;

      this.#editorAdapter.setValue(placeholder);
      this.#setDirty(true);
   }

   /**
    * Saves current script source code and associated GM storage payload.
    * @returns {Promise<{success: boolean, script?: Object, warning?: string, error?: string}>}
    */
   async save() {
      if (this.#isSaving) {
         return { success: false, error: 'Save already in progress...' };
      }

      this.#isSaving = true;
      this.setSaveButtonState(true);
      try {
         const scriptObject = await this.#buildScriptFromFormData(this.#currentScript);
         const isUserStyle = this.#elements.scriptType.value === 'userstyle';
         const rawJson = (this.#storageAdapter && !isUserStyle) ? this.#storageAdapter.getValue() : '{}';

         const storageResult = tryJSON.parse(rawJson);
         if (!storageResult.success) {
            throw new Error(`Invalid JSON in storage data: ${storageResult.error}`);
         }

         const response = await sendMessageWithRetry({ type: MSG.SAVE_SCRIPT, payload: { scriptObject } });

         if (!response) {
            throw new Error('No response received from background Service Worker.');
         }

         // Branch 1: Missing permissions required
         if (response.needsPermissions) {
            const granted = await browser.permissions.request(response.details);
            if (granted) {
               const finalResponse = await sendMessageWithRetry({ type: MSG.SAVE_SCRIPT, payload: { scriptObject } });
               if (finalResponse?.success) {
                  this.#currentScript = finalResponse.script;
                  this.#isCreatingNewScript = false;

                  await sendMessageWithRetry({
                     type: MSG.SET_SCRIPT_STORAGE,
                     payload: { scriptId: finalResponse.script.id, storageObject: storageResult.data },
                  });
                  this.#setDirty(false);
                  return { success: true, script: finalResponse.script };
               }
               throw new Error(finalResponse?.error || 'Save failed after granting permissions.');
            } else {
               // User declined permissions; save script in disabled state
               scriptObject.enabled = false;
               const finalResponse = await sendMessageWithRetry({ type: MSG.SAVE_SCRIPT, payload: { scriptObject } });
               if (finalResponse?.success) {
                  this.#currentScript = finalResponse.script;
                  this.#isCreatingNewScript = false;
                  this.#setDirty(false);
                  return { success: true, script: finalResponse.script, warning: i18n('toast_permission_denied') };
               }
               throw new Error(finalResponse?.error || 'Failed to save disabled script.');
            }
         }
         // Branch 2: Standard successful save
         else if (response.success) {
            const savedScript = response.script;
            this.#currentScript = savedScript;
            this.#isCreatingNewScript = false;

            await sendMessageWithRetry({
               type: MSG.SET_SCRIPT_STORAGE,
               payload: { scriptId: savedScript.id, storageObject: storageResult.data },
            });

            this.#setDirty(false);
            return { success: true, script: savedScript };
         }

         // Branch 3: Backend error return
         throw new Error(response.error || 'Unknown error during save.');
      } catch (err) {
         logger.error(CONTEXT, 'Script save failed:', err);
         return { success: false, error: err.message };
      } finally {
         this.#isSaving = false;
         this.setSaveButtonState(false);
      }
   }

   /**
    * @returns {boolean} True if editor has unsaved changes.
    */
   hasUnsavedChanges() {
      return this.#isDirty;
   }

   /**
    * Resolves effective match/exclude URL rules for the current editor state.
    * @returns {{finalMatches: string[], finalExcludes: string[]}}
    */
   getCurrentURLRules() {
      const userCode = this.#editorAdapter.getValue();
      const { meta } = MetadataParser.parse(userCode);
      const scriptType = this.#elements.scriptType.value;
      const urlsInputValue = this.#elements.scriptUrls.value;
      return this.resolveScriptURLRules(scriptType, userCode, meta, urlsInputValue);
   }

   /**
    * Determines active URL patterns from user custom inputs or script metadata.
    * @param {string} scriptType
    * @param {string} userCode
    * @param {Object} meta
    * @param {string} urlsInputValue
    * @returns {{finalMatches: string[], finalExcludes: string[]}}
    */
   resolveScriptURLRules(scriptType, userCode, meta, urlsInputValue) {
      const metaMatches = [].concat(meta.match || [], meta.include || []);
      const metaExcludes = [].concat(meta.exclude || []);
      const styleMatches = this.#extractMatchPatternsFromStyle(userCode);
      const defaultMatches = scriptType === 'userstyle' && styleMatches.length ? styleMatches : metaMatches;

      if (urlsInputValue.trim()) {
         const lines = urlsInputValue.split('\n').map((s) => s.trim()).filter(Boolean);
         const customMatches = lines.filter((line) => !line.startsWith('-'));
         const customExcludes = lines.filter((line) => line.startsWith('-')).map((line) => line.substring(1));

         return {
            // Preserve default matches if user only provided custom excludes (-domain)
            finalMatches: customMatches.length > 0 ? customMatches : defaultMatches,
            finalExcludes: [...metaExcludes, ...customExcludes],
         };
      }

      return { finalMatches: defaultMatches, finalExcludes: metaExcludes };
   }

   /**
    * Updates save button interactive state and visual text.
    * @param {boolean} isSaving
    */
   setSaveButtonState(isSaving) {
      const saveBtn = this.#elements.saveBtn;
      if (!saveBtn) return;
      saveBtn.disabled = isSaving;
      saveBtn.textContent = isSaving
         ? i18n('opt_btn_save_settings_process') || 'Saving...'
         : i18n('opt_btn_save_settings') || 'Save';
   }

   /**
    * Updates Google Drive sync checkbox visibility in storage panel.
    * @param {boolean} isSynced
    */
   setSyncState(isSynced) {
      if (!this.#currentScript) return;

      const syncStorageWrapper = document.getElementById('sync-storage-wrapper');
      const syncStorageCheckbox = document.getElementById('sync-storage-checkbox');

      if (syncStorageWrapper && syncStorageCheckbox) {
         if (isSynced && this.#currentScript.type !== 'userstyle') {
            syncStorageWrapper.classList.remove('hide');
            syncStorageCheckbox.checked = this.#currentScript.config?.syncStorage !== false;
         } else {
            syncStorageWrapper.classList.add('hide');
         }
      }
   }

   // --- Private Methods ---

   /**
    * Cache DOM elements used by editor manager.
    * @private
    */
   #initializeElements() {
      this.#elements = {
         toggleWordWrapBtn: this.#form.querySelector('#toggle-word-wrap-btn'),
         formatBtn: this.#form.querySelector('#format-code-btn'),
         copyUrlsBtn: document.getElementById('copy-script-urls-btn'),
         saveBtn: this.#form.querySelector('button[type="submit"]'),
         scriptType: this.#form.querySelector('#script-type'),
         scriptUrls: this.#form.querySelector('#script-urls'),
         patternTester: document.getElementById('pattern-tester'),
         testUrlInput: document.getElementById('test-url-input'),
         clearTestUrlBtn: document.getElementById('clear-test-url-btn'),
         testUrlResult: document.getElementById('test-url-result'),
         storagePanel: document.querySelector('.panel.storage'),
         storageData: document.getElementById('storage-data'),
         storageDataEditCheckbox: document.getElementById('storage-data-agree-edit'),
         storageError: document.getElementById('storage-error'),
         scriptCodeTextarea: this.#form.querySelector('#script-code'),
         scriptCodeCodeMirrors: this.#form.querySelector('#editor-container'),
      };
   }

   /**
    * Sets up the main source code adapter.
    * @private
    * @param {boolean} useSimpleEditor
    */
   #setupEditor(useSimpleEditor) {
      const { scriptCodeTextarea, scriptCodeCodeMirrors, toggleWordWrapBtn } = this.#elements;
      const isWordWrapEnabled = localStorage.getItem('lite_monkey_word_wrap') === 'true';

      if (useSimpleEditor) {
         scriptCodeTextarea.classList.remove('hide');
         scriptCodeCodeMirrors.classList.add('hide');
         this.#editorAdapter = new TextareaAdapter(scriptCodeTextarea);
      } else {
         scriptCodeTextarea.classList.add('hide');
         scriptCodeCodeMirrors.classList.remove('hide');
         this.#editorAdapter = new CodeMirrorAdapter(scriptCodeCodeMirrors);
      }

      // Sync initial button state and apply wrap
      if (toggleWordWrapBtn) {
         toggleWordWrapBtn.classList.toggle('active', isWordWrapEnabled);
      }
      this.#editorAdapter.setWordWrap(isWordWrapEnabled);
   }

   /**
    * Sets up the GM storage editor adapter.
    * @private
    * @param {boolean} useSimpleEditor
    */
   #setupStorageEditor(useSimpleEditor) {
      const storageData = document.getElementById('storage-data');
      const storageContainer = document.getElementById('storage-container');

      if (useSimpleEditor) {
         storageData.classList.remove('hide');
         storageContainer.classList.add('hide');
         this.#storageAdapter = new TextareaAdapter(storageData);
      } else {
         storageData.classList.add('hide');
         storageContainer.classList.remove('hide');
         this.#storageAdapter = new CodeMirrorAdapter(storageContainer, '', 'userscript');
      }

      this.#storageAdapter.setReadOnly(true);
   }

   /**
    * Attaches event listeners to editor elements.
    * @private
    */
   #attachListeners() {
      this.#form.addEventListener('input', ({ target }) => {
         if (!target.closest('.no-dirty-check')) {
            this.#setDirty(true);
         }
      });

      this.#elements.toggleWordWrapBtn?.addEventListener('click', () => {
         const isCurrentlyWrapped = this.#elements.toggleWordWrapBtn.classList.contains('active');
         const newWrapState = !isCurrentlyWrapped;

         this.#elements.toggleWordWrapBtn.classList.toggle('active', newWrapState);
         localStorage.setItem('lite_monkey_word_wrap', String(newWrapState));
         this.#editorAdapter.setWordWrap(newWrapState);
      });

      this.#elements.formatBtn?.addEventListener('click', () => this.#formatCode());
      this.#elements.scriptType?.addEventListener('change', () => this.#onScriptTypeChange());
      this.#elements.storageDataEditCheckbox?.addEventListener('change', () => {
         const isEditable = this.#elements.storageDataEditCheckbox.checked;

         if (this.#storageAdapter) {
            this.#storageAdapter.setReadOnly(!isEditable);
         }

         if (isEditable) {
            this.#validateJson();
         }
      });

      if (this.#storageAdapter) {
         this.#storageAdapter.onChange(() => {
            this.#validateJson();
            // Mark editor dirty when raw storage JSON is modified by user to prevent silent data loss
            if (this.#elements.storageDataEditCheckbox?.checked) {
               this.#setDirty(true);
            }
         });
      }

      const syncStorageCheckbox = document.getElementById('sync-storage-checkbox');
      if (syncStorageCheckbox) {
         syncStorageCheckbox.addEventListener('change', async () => {
            if (!this.#currentScript) return;

            const value = syncStorageCheckbox.checked;
            this.#currentScript.config.syncStorage = value;

            await sendMessageWithRetry({
               type: MSG.UPDATE_SCRIPT_PROPS,
               payload: {
                  scriptId: this.#currentScript.id,
                  props: { config: { ...this.#currentScript.config, syncStorage: value } },
               },
            });
         });
      }

      if (this.#elements.copyUrlsBtn) {
         this.#elements.copyUrlsBtn.addEventListener('click', () => this.#copyOriginalUrlsToInput());
      }

      const debouncedTestUrlPatterns = () => {
         clearTimeout(this.#testDebounceTimeout);
         this.#testDebounceTimeout = setTimeout(() => {
            this.#handleTestUrlPatterns();
         }, 200);
      };

      // Pattern URL tester event listeners
      this.#elements.testUrlInput?.addEventListener('input', debouncedTestUrlPatterns);
      this.#elements.scriptUrls?.addEventListener('input', debouncedTestUrlPatterns);

      this.#elements.clearTestUrlBtn?.addEventListener('click', () => {
         this.#elements.testUrlInput.value = '';
         debouncedTestUrlPatterns();
         this.#elements.testUrlInput.focus();
      });
   }

   /**
    * Formats source code dynamically using Prettier libraries loaded on demand.
    * @private
    */
   async #formatCode() {
      const btn = this.#elements.formatBtn;
      if (!btn || btn.disabled) return;

      const scriptType = this.#elements.scriptType.value;
      const code = this.#editorAdapter.getValue();

      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.textContent = i18n('opt_btn_formatting') || 'Formatting...';

      try {
         // Lazy load Prettier dynamic modules only when user requests formatting
         const [prettier, prettierPluginBabel, prettierPluginEstree, prettierPluginPostcss] = await Promise.all([
            import('../../libs/codemirror/prettier/standalone.js'),
            import('../../libs/codemirror/prettier/plugins/babel.js'),
            import('../../libs/codemirror/prettier/plugins/estree.js'),
            import('../../libs/codemirror/prettier/plugins/postcss.js'),
         ]);

         const parser = scriptType === 'userscript' ? 'babel' : 'css';
         const plugins =
            scriptType === 'userscript'
               ? [prettierPluginBabel.default || prettierPluginBabel, prettierPluginEstree.default || prettierPluginEstree]
               : [prettierPluginPostcss.default || prettierPluginPostcss];

         const formattedCode = await prettier.format(code, { parser, plugins, tabWidth: 2, semi: true });

         this.#editorAdapter.setValue(formattedCode);
         this.#setDirty(true);
      } catch (err) {
         logger.error(CONTEXT, 'Prettier formatting failed:', err);
      } finally {
         btn.disabled = false;
         btn.classList.remove('is-loading');
         btn.textContent = i18n('opt_btn_format') || 'Format';
      }
   }

   /**
    * Constructs payload script object from active form fields and code metadata.
    * @private
    * @param {Object|null} originalScript
    * @returns {Promise<Object>}
    */
   async #buildScriptFromFormData(originalScript = null) {
      const userCode = this.#editorAdapter.getValue();
      if (!userCode) throw new Error(i18n('opt_alert_script_code_empty'));
      if (!this.#validateJson()) throw new Error(i18n('toast_fix_errors_before_saving'));

      const { meta } = MetadataParser.parse(userCode);
      const noMetaBlock = Object.keys(meta).length === 0;
      const customRulesRaw = this.#elements.scriptUrls.value.trim();

      if (noMetaBlock && !customRulesRaw) {
         this.#elements.scriptUrls.setAttribute('required', 'true');
         throw new Error('URL rules are required for scripts without a metadata block.');
      } else {
         this.#elements.scriptUrls.removeAttribute('required');
      }

      if (noMetaBlock) {
         // Retain original script name on resave if it was already created
         let scriptName = originalScript?.meta?.name || null;
         if (!scriptName) {
            const firstLine = userCode.trim().split('\n')[0].trim();
            if (firstLine.startsWith('//')) scriptName = firstLine.substring(2).trim();
            else if (firstLine.startsWith('/*') && firstLine.endsWith('*/')) {
               scriptName = firstLine.substring(2, firstLine.length - 2).trim();
            }
            scriptName = scriptName || `Untitled Snippet ${Date.now()}`;
         }
         meta.name = scriptName || `Untitled Snippet ${Date.now()}`;
         meta.grant = 'none';
      }

      const script = originalScript ? { ...originalScript } : {};
      if (!originalScript) {
         script.enabled = true; // Default to enabled for new scripts to trigger initial permission check
      }

      const { finalMatches, finalExcludes } = this.resolveScriptURLRules(
         this.#elements.scriptType.value,
         userCode,
         meta,
         this.#elements.scriptUrls.value
      );

      const hasCustomRules = customRulesRaw.length > 0;

      script.type = this.#elements.scriptType.value;
      script.userCode = userCode;
      script.customUrls = hasCustomRules ? customRulesRaw : null;
      script.meta = {
         ...meta,
         match: this.#compilePatterns(finalMatches),
         exclude: this.#compilePatterns(finalExcludes),
         ...(hasCustomRules && { include: [] }), // Clear legacy @include rules when custom override exists
      };

      // Storage payload is managed separately and excluded from main script object
      delete script.storage;

      return script;
   }

   /**
    * Updates editor dirty (unsaved changes) state.
    * @private
    * @param {boolean} isDirty
    */
   #setDirty(isDirty) {
      if (this.#isDirty === isDirty) return;
      this.#isDirty = isDirty;
      this.#elements.saveBtn.classList.toggle('unsaved', isDirty);
      this.#form.dispatchEvent(new CustomEvent('editorDirtyStateChange', { detail: { isDirty }, bubbles: true }));
   }

   /**
    * Handles script type selector change event.
    * @private
    */
   #onScriptTypeChange() {
      if (this.#editorAdapter instanceof CodeMirrorAdapter) {
         this.#editorAdapter.reconfigure(this.#elements.scriptType.value);
      }
      const currentCode = this.#editorAdapter.getValue().trim();
      const isPristinePlaceholder = Object.values(PLACEHOLDERS).some((p) => p.trim() === currentCode);
      if (this.#isCreatingNewScript && isPristinePlaceholder) {
         const newPlaceholder = PLACEHOLDERS[this.#elements.scriptType.value] || '';
         this.#editorAdapter.setValue(newPlaceholder);
         this.#setDirty(false);
      }
   }

   /**
    * Updates GM storage panel display depending on script type and `@grant` permissions.
    * @private
    */
   #updateStoragePanelState() {
      const { scriptType, storagePanel, storageDataEditCheckbox } = this.#elements;
      if (scriptType.value === 'userstyle') {
         storagePanel.style.display = 'none';
         return;
      }
      const { meta } = MetadataParser.parse(this.#editorAdapter.getValue());
      const grants = [].concat(meta?.grant || []);
      const hasStorageGrant = grants.includes('GM_setValue') || grants.includes('GM_getValue');
      storagePanel.style.display = hasStorageGrant ? '' : 'none';
      storageDataEditCheckbox.disabled = !hasStorageGrant;
      if (!hasStorageGrant) {
         storageDataEditCheckbox.checked = false;
         if (this.#storageAdapter) {
            this.#storageAdapter.setReadOnly(true);
         }
      }
   }

   /**
    * Validates storage panel JSON syntax.
    * @private
    * @returns {boolean} True if JSON is valid syntax
    */
   #validateJson() {
      const { storageError } = this.#elements;

      const rawJson = this.#storageAdapter ? this.#storageAdapter.getValue() : '{}';
      const result = tryJSON.parse(rawJson);

      const storageDomElement = document.getElementById('storage-data') || document.getElementById('storage-container');
      if (storageDomElement) {
         storageDomElement.classList.toggle('invalid-json', !result.success);
      }

      if (storageError) {
         storageError.textContent = result.error || '';
      }
      return result.success;
   }

   /**
    * Updates placeholder text in URL pattern input field.
    * @private
    */
   #updateURLRulesPlaceholder() {
      const { meta } = MetadataParser.parse(this.#editorAdapter.getValue());
      this.#elements.scriptUrls.placeholder =
         Object.keys(meta).length === 0
            ? i18n('opt_url_rules_placeholder_headless')
            : i18n('opt_url_rules_placeholder_override');
   }

   /**
    * Updates pattern tester widget panel state.
    * @private
    */
   #updateTesterState() {
      const isScriptSelected = !!this.#currentScript;
      this.#elements.patternTester.style.display = isScriptSelected ? 'flex' : 'none';
      this.#elements.testUrlResult.textContent = '';
      this.#elements.testUrlResult.className = 'test-result';
      this.#elements.clearTestUrlBtn.classList.toggle('hide', !this.#elements.testUrlInput.value);
   }

   /**
    * Evaluates input test URL against effective match and exclude patterns.
    * @private
    */
   #handleTestUrlPatterns() {
      const { testUrlInput, testUrlResult, clearTestUrlBtn } = this.#elements;
      const url = testUrlInput.value.trim();
      clearTestUrlBtn.classList.toggle('hide', !url);
      if (!url) {
         testUrlResult.textContent = '';
         return;
      }
      const { finalMatches, finalExcludes } = this.getCurrentURLRules();
      const isMatched = finalMatches.length === 0 || finalMatches.some((p) => new MatchPattern(p).toRegex()?.test(url));
      const isExcluded = finalExcludes.some((p) => new MatchPattern(p).toRegex()?.test(url));
      const passed = isMatched && !isExcluded;
      testUrlResult.innerHTML = `
         <span class="matched" tooltip="Matched: ${isMatched ? 'Yes' : 'No'}">Matched:${isMatched ? '✅' : '❌'}</span>
         <span class="excluded" tooltip="Excluded: ${isExcluded ? 'Yes' : 'No'}">Excluded:${isExcluded ? '✅' : '❌'}</span>`;
      testUrlResult.title = `Passed: ${passed}\nMatched: ${isMatched}\nExcluded: ${isExcluded}`;
   }

   /**
    * Extracts domain match rules from `@-moz-document` sections in UserStyle code.
    * @private
    * @param {string} code
    * @returns {string[]}
    */
   #extractMatchPatternsFromStyle(code) {
      const patterns = new Set();
      const mozDocumentRegex = /@\-moz\-document\s*([^{]+?)\s*{/g;
      const domainRegex = /domain\("([^"]+)"\)/g;
      const urlPrefixRegex = /url-prefix\("([^"]+)"\)/g;
      let mozMatch;
      while ((mozMatch = mozDocumentRegex.exec(code)) !== null) {
         const ruleString = mozMatch[1];
         let subMatch;
         domainRegex.lastIndex = 0;
         while ((subMatch = domainRegex.exec(ruleString)) !== null) {
            const domain = subMatch[1].trim();
            if (domain) {
               patterns.add(`*://${domain}/*`);
               patterns.add(`*://*.${domain}/*`);
            }
         }
         urlPrefixRegex.lastIndex = 0;
         while ((subMatch = urlPrefixRegex.exec(ruleString)) !== null) {
            const prefix = subMatch[1].trim();
            if (prefix) patterns.add(`${prefix}*`);
         }
      }
      return Array.from(patterns);
   }

   /**
    * Compiles pattern strings using MatchPattern parser while preserving RegExp literals.
    * @private
    * @param {string[]} patterns
    * @returns {string[]}
    */
   #compilePatterns(patterns) {
      // Preserve RegExp literals (e.g. /regex/flags) without running them through MatchPattern
      return patterns
         .map((p) => {
            if (typeof p !== 'string') return null;
            const trimmed = p.trim();
            if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
               return trimmed;
            }
            return new MatchPattern(trimmed).pattern;
         })
         .filter(Boolean);
   }

   /**
    * Copies original metadata URL patterns into input field override.
    * @private
    */
   #copyOriginalUrlsToInput() {
      const userCode = this.#editorAdapter.getValue();
      const { meta } = MetadataParser.parse(userCode);
      const scriptType = this.#elements.scriptType.value;

      let matches = [].concat(meta.match || [], meta.include || []);
      const excludes = [].concat(meta.exclude || []);

      if (scriptType === 'userstyle' && matches.length === 0) {
         matches = this.#extractMatchPatternsFromStyle(userCode);
      }

      const formattedRules = [...matches, ...excludes.map((ex) => `-${ex}`)].join('\n');

      this.#elements.scriptUrls.value = formattedRules;
      this.#setDirty(true);
      this.#handleTestUrlPatterns();
   }
}
