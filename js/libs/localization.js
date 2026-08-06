import browser from './browser-support.js';

/**
 * @module Localizer
 * @description Provides internationalization (i18n) helpers for extension UI pages (Popup, Options, Editor).
 * Automatically scans and replaces standard WebExtension `__MSG_key__` markup placeholders in DOM nodes.
 */

/**
 * Retrieves a localized string for a given translation key from `_locales/`.
 * If the translation is missing, returns the key formatted as `i18n: {key}` for debugging.
 *
 * @param {string} key - The translation key defined in messages.json.
 * @param {string|string[]} [subs=[]] - Optional substitution string(s) for $PLACEHOLDERS$.
 * @returns {string} The localized message string or debug fallback identifier.
 */
const i18n = (key, subs = []) => {
   const message = browser?.i18n?.getMessage?.(key, subs);

   if (!message && key) {
      console.error(`[Localizer] Localization missing for key: "${key}"`);
      return `i18n: {${key}}`;
   }

   return message;
};

export { i18n };

/**
 * Replaces `__MSG_key__` placeholders in string content with localized messages.
 *
 * @private
 * @param {string} text - Raw string containing `__MSG_...__` tokens.
 * @param {typeof i18n} [fn=i18n] - Resolver function for localized keys.
 * @returns {string} String with all matching `__MSG_` placeholders translated.
 */
function translatePlaceholders(text, fn = i18n) {
   if (!text?.includes('__MSG_')) return text;

   // Matches standard WebExtension placeholder format: __MSG_key_name__
   return text.replace(/__MSG_(\w+[\w-]*)__/g, (_, key) => fn(key));
}

/**
 * Recursively localizes text nodes and element attributes within a DOM subtree.
 *
 * @private
 * @param {Node} node - DOM node (Element, Text, or DocumentFragment) to localize.
 * @param {typeof i18n} [fn=i18n] - Resolver function.
 */
function localizeNode(node, fn = i18n) {
   switch (node.nodeType) {
      case Node.TEXT_NODE: {
         if (node.nodeValue?.trim()) {
            node.nodeValue = translatePlaceholders(node.nodeValue, fn);
         }
         break;
      }

      case Node.ELEMENT_NODE: {
         // Skip inline script execution blocks and style sheets to prevent corrupting code/CSS
         if (['SCRIPT', 'STYLE'].includes(node.tagName)) return;

         // Translate element attributes (e.g. placeholder="__MSG_search__", title="__MSG_title__")
         for (const attr of node.attributes) {
            if (attr.value?.trim()) {
               attr.value = translatePlaceholders(attr.value, fn);
            }
         }

         // Recursively translate child nodes
         node.childNodes.forEach((child) => localizeNode(child, fn));
         break;
      }

      case Node.DOCUMENT_FRAGMENT_NODE: {
         node.childNodes.forEach((child) => localizeNode(child, fn));
         break;
      }
   }
}

/**
 * Performs full-page DOM localization using fast native query selectors and TreeWalker.
 * Checks for `data-localized` on `<html>` to guarantee single execution per page lifecycle.
 *
 * @private
 */
function initializeLocalization() {
   const markerAttr = 'data-localized';
   if (document.documentElement.hasAttribute(markerAttr)) return;

   try {
      // Use native querySelectorAll for elements with attributes needing translation
      const elements = document.querySelectorAll('*');
      for (let i = 0; i < elements.length; i++) {
         const el = elements[i];
         if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;

         for (let j = 0; j < el.attributes.length; j++) {
            const attr = el.attributes[j];
            if (attr.value && attr.value.includes('__MSG_')) {
               attr.value = translatePlaceholders(attr.value);
            }
         }
      }

      // Replace JavaScript recursion with native browser TreeWalker C++ iterator
      if (document.body) {
         const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
         let node;
         while ((node = walker.nextNode())) {
            if (node.nodeValue && node.nodeValue.includes('__MSG_')) {
               node.nodeValue = translatePlaceholders(node.nodeValue);
            }
         }
      }

      const titleNode = document.querySelector('head > title');
      if (titleNode && titleNode.textContent.includes('__MSG_')) {
         titleNode.textContent = translatePlaceholders(titleNode.textContent);
      }

      document.documentElement.setAttribute(markerAttr, 'true');
   } catch (err) {
      console.error('[Localizer] Page localization failed:', err);
   }
}

// Self-initialize localization as soon as DOM tree parsing completes
if (document.readyState === 'interactive' || document.readyState === 'complete') {
   initializeLocalization();
} else {
   window.addEventListener('DOMContentLoaded', initializeLocalization, {
      capture: true,
      once: true,
   });
}
