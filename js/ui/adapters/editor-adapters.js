// Core CodeMirror modules
import { EditorState, Compartment } from '../../libs/codemirror/@codemirror/state.js';
import { EditorView, keymap, lineNumbers } from '../../libs/codemirror/@codemirror/view.js';

// Features and keymaps
import { defaultKeymap, history, indentWithTab } from '../../libs/codemirror/@codemirror/commands.js';
import {
   autocompletion,
   closeBrackets,
   closeBracketsKeymap,
   completionKeymap,
} from '../../libs/codemirror/@codemirror/autocomplete.js';
// Language syntax highlighting
import { javascript } from '../../libs/codemirror/@codemirror/lang-javascript.js';
import { css } from '../../libs/codemirror/@codemirror/lang-css.js';
// Theme
import { oneDark } from '../../libs/codemirror/@codemirror/theme-one-dark.js';

// List of Greasemonkey / Tampermonkey API completions for CodeMirror IDE experience
const GM_COMPLETIONS = [
   { label: 'GM_getValue', type: 'function', detail: '(key, defaultValue)', boost: 10 },
   { label: 'GM_setValue', type: 'function', detail: '(key, value)', boost: 10 },
   { label: 'GM_deleteValue', type: 'function', detail: '(key)', boost: 10 },
   { label: 'GM_listValues', type: 'function', detail: '()', boost: 10 },
   { label: 'GM_addValueChangeListener', type: 'function', detail: '(key, callback)', boost: 9 },
   { label: 'GM_removeValueChangeListener', type: 'function', detail: '(listenerId)', boost: 9 },
   { label: 'GM_xmlhttpRequest', type: 'function', detail: '({ method, url, onload... })', boost: 10 },
   { label: 'GM_addStyle', type: 'function', detail: '(css)', boost: 10 },
   { label: 'GM_addElement', type: 'function', detail: '(tag, attrs)', boost: 9 },
   { label: 'GM_setClipboard', type: 'function', detail: '(text, type)', boost: 9 },
   { label: 'GM_download', type: 'function', detail: '({ url, name })', boost: 9 },
   { label: 'GM_notification', type: 'function', detail: '({ text, title, icon })', boost: 9 },
   { label: 'GM_registerMenuCommand', type: 'function', detail: '(caption, callback)', boost: 9 },
   { label: 'GM_unregisterMenuCommand', type: 'function', detail: '(commandId)', boost: 9 },
   { label: 'GM_getResourceText', type: 'function', detail: '(name)', boost: 8 },
   { label: 'GM_getResourceURL', type: 'function', detail: '(name)', boost: 8 },
   { label: 'GM_log', type: 'function', detail: '(...args)', boost: 8 },
   { label: 'GM_info', type: 'variable', detail: 'Script metadata object', boost: 10 },
   { label: 'unsafeWindow', type: 'variable', detail: 'Raw page window context', boost: 10 },
];

/**
 * Custom completion source for Greasemonkey APIs inside CodeMirror.
 */
function gmApiCompletions(context) {
   const word = context.matchBefore(/\bGM_\w*/);
   if (!word && !context.explicit) return null;
   return {
      from: word ? word.from : context.pos,
      options: GM_COMPLETIONS,
   };
}

/**
 * Defines a common interface for editor adapters to ensure a consistent API.
 * This pattern allows swapping editor implementations (e.g., CodeMirror vs Textarea)
 * without modifying consuming components.
 * @abstract
 */
class EditorAdapter {
   /**
    * Sets the text content in the editor.
    * @param {string} code
    */
   setValue(code) {
      throw new Error('Adapter method "setValue" not implemented.');
   }

   /**
    * Retrieves current text content from the editor.
    * @returns {string}
    */
   getValue() {
      throw new Error('Adapter method "getValue" not implemented.');
   }

   /**
    * Registers a callback listener triggered when content changes.
    * @param {Function} callback
    */
   onChange(callback) {
      throw new Error('Adapter method "onChange" not implemented.');
   }

   /**
    * Focuses the editor input area.
    */
   focus() {
      throw new Error('Adapter method "focus" not implemented.');
   }

   /**
    * Cleans up listeners and destroys editor resources.
    */
   destroy() {
      throw new Error('Adapter method "destroy" not implemented.');
   }

   /**
    * Reconfigures editor syntax highlighting language mode.
    * @param {'userscript'|'userstyle'} scriptType
    */
   reconfigure(scriptType) { }

   /**
    * Sets editor read-only mode.
    * @param {boolean} isReadOnly
    */
   setReadOnly(isReadOnly) { }

   // Interface method for toggling word wrap
   setWordWrap(enabled) { }
}

/**
 * Adapter implementation for standard HTML <textarea> elements.
 * Provides a lightweight fallback and accessibility option.
 */
class TextareaAdapter extends EditorAdapter {
   #textarea;
   #onChangeCallback = null;
   #inputListener = () => this.#onChangeCallback?.();

   /**
    * @param {HTMLTextAreaElement} element
    */
   constructor(element) {
      super();
      this.#textarea = element;
      this.#textarea.addEventListener('input', this.#inputListener);
   }

   /** @override */
   setValue(code) {
      this.#textarea.value = code;
   }

   /** @override */
   getValue() {
      return this.#textarea.value;
   }

   /** @override */
   onChange(callback) {
      this.#onChangeCallback = callback;
   }

   /** @override */
   focus() {
      this.#textarea.focus();
   }

   /** @override */
   destroy() {
      this.#textarea.removeEventListener('input', this.#inputListener);
   }

   /** @override */
   setReadOnly(isReadOnly) {
      this.#textarea.readOnly = isReadOnly;
   }

   /** @override */
   setWordWrap(enabled) {
      this.#textarea.style.whiteSpace = enabled ? 'pre-wrap' : 'pre';
   }
}

/**
 * Adapter implementation for the CodeMirror 6 editor.
 * Encapsulates initialization, dynamic syntax switching, and view updates.
 */
class CodeMirrorAdapter extends EditorAdapter {
   #editorView;
   #onChangeCallback = null;

   /** @type {Compartment} CodeMirror compartment for dynamic syntax language reconfiguration */
   #languageConf = new Compartment();

   /** @type {Compartment} CodeMirror compartment for dynamic editable/read-only mode toggling */
   #editableConf = new Compartment();

   /** @type {Compartment} CodeMirror compartment for dynamic dynamic word wrap toggling */
   #wrapConf = new Compartment();

   /** @type {Array<any>} Base extensions shared across CodeMirror instances */
   static #BASE_EXTENSIONS = [
      lineNumbers(),
      history(),
      closeBrackets(),
      autocompletion({ override: [gmApiCompletions] }),
      keymap.of([...defaultKeymap, ...closeBracketsKeymap, ...completionKeymap, indentWithTab]),
      oneDark,
   ];

   /**
    * @param {HTMLElement} parentElement Container element into which CodeMirror will mount
    * @param {string} [initialCode=''] Initial document content
    * @param {'userscript'|'userstyle'} [scriptType='userscript'] Initial language mode
    */
   constructor(parentElement, initialCode = '', scriptType = 'userscript', initialWrap = false) {
      super();
      const languageExtension = scriptType === 'userstyle' ? css() : javascript();

      parentElement.innerHTML = '';

      const initialState = EditorState.create({
         doc: initialCode,
         extensions: [
            ...CodeMirrorAdapter.#BASE_EXTENSIONS,
            EditorView.updateListener.of((update) => {
               if (update.docChanged) {
                  this.#onChangeCallback?.();
               }
            }),
            // Language extension is placed in a compartment to allow dynamic mode reconfiguration
            this.#languageConf.of(languageExtension),
            // Editable extension is placed in a compartment for on-the-fly readOnly switching
            this.#editableConf.of(EditorView.editable.of(true)),
            this.#wrapConf.of(initialWrap ? EditorView.lineWrapping : []),
         ],
      });

      this.#editorView = new EditorView({
         state: initialState,
         parent: parentElement,
      });
   }

   /** @override */
   setValue(code) {
      this.#editorView.dispatch({
         changes: { from: 0, to: this.#editorView.state.doc.length, insert: code },
      });
   }

   /** @override */
   getValue() {
      return this.#editorView.state.doc.toString();
   }

   /** @override */
   onChange(callback) {
      this.#onChangeCallback = callback;
   }

   /** @override */
   focus() {
      this.#editorView.focus();
   }

   /** @override */
   destroy() {
      this.#editorView.destroy();
   }

   /** @override */
   reconfigure(scriptType) {
      const newLanguage = scriptType === 'userstyle' ? css() : javascript();
      this.#editorView.dispatch({
         effects: this.#languageConf.reconfigure(newLanguage),
      });
   }

   /** @override */
   setReadOnly(isReadOnly) {
      this.#editorView.dispatch({
         effects: this.#editableConf.reconfigure(EditorView.editable.of(!isReadOnly)),
      });
   }

   /** @override */
   setWordWrap(enabled) {
      this.#editorView.dispatch({
         effects: this.#wrapConf.reconfigure(enabled ? EditorView.lineWrapping : []),
      });
   }
}

export { TextareaAdapter, CodeMirrorAdapter };
