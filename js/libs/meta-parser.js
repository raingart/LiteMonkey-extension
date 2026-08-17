/**
 * @module MetadataParser
 * @description Parser and generator for userscript (`// ==UserScript==`) and userstyle (`/* ==UserStyle==`)
 * metadata blocks. Extracts metadata directives such as `@match`, `@grant`, `@resource`, and `@var`.
 */

/** Max offset from file start where a metadata header may begin (skips HTML wrappers). */
export const META_HEADER_SEARCH_LIMIT = 32 * 1024;

// Explicit list of multi-value directives that legitimately produce arrays
const MULTI_VALUE_DIRECTIVES = new Set([
   'match',
   'include',
   'exclude',
   'require',
   'grant',
   'connect',
]);

export const MetadataParser = {
   /**
    * Reconstructs a standardized userscript metadata block string from a metadata object.
    * Used for populating `GM_info.scriptMetaStr` or serializing modified script headers.
    *
    * @param {Record<string, any>} [meta={}] - The script metadata dictionary.
    * @returns {string} Formatted `// ==UserScript==` metadata block string.
    */
   generateMetaBlock(meta = {}) {
      const lines = ['// ==UserScript=='];

      for (const [key, value] of Object.entries(meta ?? {})) {
         if (key === 'var') continue; // User-configurable variables (@var) are stored separately

         // Serialize @resource dictionaries as "// @resource name url" instead of [object Object]
         if (key === 'resource' && value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [resName, resUrl] of Object.entries(value)) {
               if (resName && resUrl) {
                  lines.push(`// @resource ${resName} ${resUrl}`);
               }
            }
            continue;
         }

         const values = Array.isArray(value) ? value : [value];
         values.forEach((v) => {
            // Handle boolean directives (e.g. @noframes) without appending "true"
            if (v === true) {
               lines.push(`// @${key}`);
            } else if (v && typeof v !== 'object') {
               lines.push(`// @${key} ${v}`);
            }
         });
      }

      lines.push('// ==/UserScript==');
      return lines.join('\n');
   },

   /**
    * Parses the metadata header block from script or style source content.
    * Automatically detects both userscript (`// ==UserScript==`) and userstyle (`/* ==UserStyle==`) formats.
    *
    * @param {string} str - The full script content string.
    * @returns {{ meta: Record<string, any>, type: 'userscript' | 'userstyle' }} Parsed metadata object and script type. Never returns null.
    */
   parse(str) {
      if (typeof str !== 'string' || !str.trim()) {
         return { meta: {}, type: 'userscript', metaBlockStr: '' };
      }

      const markers = {
         userscript: { prefix: '// ==UserScript==', suffix: '// ==/UserScript==' },
         userstyle: { prefix: '/* ==UserStyle==', suffix: '==/UserStyle== */' },
      };

      const searchWindow = str.length > META_HEADER_SEARCH_LIMIT
         ? str.slice(0, META_HEADER_SEARCH_LIMIT)
         : str;

      for (const [type, { prefix, suffix }] of Object.entries(markers)) {
         // Header must start near the beginning of the file, not anywhere in an HTML wrapper
         const startIndex = searchWindow.indexOf(prefix);
         if (startIndex !== -1) {
            const subStr = str.substring(startIndex);
            const { meta, metaBlockStr } = this.process({ str: subStr, suffix });
            return { meta, type, metaBlockStr };
         }
      }

      return { meta: {}, type: 'userscript', metaBlockStr: '' };
   },

   /**
    * Iterates through lines in a metadata block to map `@directive` lines into a metadata dictionary.
    *
    * @param {object} params
    * @param {string} params.str - The script content string.
    * @param {string} params.suffix - Expected metadata block closing marker.
    * @returns {Record<string, any>} Key-value map of parsed metadata directives.
    */
   process({ str, suffix }) {
      if (typeof str !== 'string') return { meta: {}, metaBlockStr: '' };

      // Locate closing marker and slice header first to avoid splitting 50k+ lines of full source code in RAM
      const suffixIdx = str.indexOf(suffix);
      if (suffixIdx === -1) return { meta: {}, metaBlockStr: '' };

      const headerEndIdx = suffixIdx + suffix.length;
      const metaBlockStr = str.substring(0, headerEndIdx);
      const lines = metaBlockStr.split('\n');

      const rawMeta = lines.slice(1, lines.length - 1).reduce((acc, line) => {
         // Matches directives including optional 2-letter locale suffixes (e.g. @name, @name:de)
         // Support standard BCP 47 locale subtags (e.g. @name:zh-CN, @description:pt-BR)
         const match = line.trim().match(/@([\w-]+(?::[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]+)?)?)\s*(.*)/);
         if (!match) return acc;

         const [, key, valueRaw] = match;
         const value = valueRaw?.trim();
         if (!key) return acc;

         if (!value) {
            acc[key] = true;
            return acc;
         }

         if (key === 'resource') {
            // Parse @resource <resourceName> <resourceUrl>
            const spaceIdx = value.search(/\s/);
            if (spaceIdx !== -1) {
               const resourceName = value.substring(0, spaceIdx).trim();
               const resourceUrl = value.substring(spaceIdx).trim();
               if (resourceName && resourceUrl) {
                  if (!acc.resource) acc.resource = {};
                  acc.resource[resourceName] = resourceUrl;
               }
            }
            return acc;
         }

         if (key === 'var') {
            // Parse @var "variableName" "description" "defaultValue"
            return this.parseVar(acc, value.split('"').map((p) => p.trim()).filter(Boolean));
         }

         // Restrict array accumulation exclusively to multi-value directives
         if (MULTI_VALUE_DIRECTIVES.has(key)) {
            // Default key/value handling: aggregate repeating directives (e.g. @match, @grant) into arrays

            if (acc[key]) {
               acc[key] = Array.isArray(acc[key]) ? [...acc[key], value] : [acc[key], value];
            } else {
               acc[key] = [value];
            }
         } else {
            // Scalar directive: latest header value overrides previous, stored strictly as string
            acc[key] = String(value);
         }

         return acc;
      }, {});

      // Post-processing pass guarantees scalar fields are never arrays
      for (const [k, v] of Object.entries(rawMeta)) {
         if (!MULTI_VALUE_DIRECTIVES.has(k) && k !== 'resource' && k !== 'var' && Array.isArray(v)) {
            rawMeta[k] = String(v[v.length - 1] ?? '');
         }
      }

      return { meta: rawMeta, metaBlockStr };
   },

   /**
    * Parses user-configurable script variables defined via `@var`.
    *
    * @param {Record<string, any>} acc - Accumulator metadata object.
    * @param {string[]} parts - Decomposed parameter array [name, description, defaultValue].
    * @returns {Record<string, any>} Updated metadata accumulator object.
    */
   parseVar(acc, [name, description, defaultValue]) {
      if (!name || !description || !defaultValue) return acc;
      acc.var = [...(acc.var || []), { name, description, default: defaultValue }];
      return acc;
   },
};
