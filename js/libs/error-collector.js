import browser from './browser-support.js';

/**
 * @module ErrorCollector
 * @description Centralized error collection and diagnostic reporting system.
 * Captures, formats, and persists runtime exceptions to local storage with a rolling cap.
 * Generates pre-filled diagnostic issue reports via Google Forms for extension UI contexts.
 */

// --- Constants ---
const APP_VERSION = browser?.runtime?.getManifest?.()?.version ?? '0.0.0';
const STORAGE_KEY = 'error_collector_logs';
const MAX_ENTRIES = 100;
const MAX_STRING_LENGTH = 1500;

const GOOGLE_FORM_URL = 'https://docs.google.com/forms/u/0/d/e/1FAIpQLScfpAvLoqWlD5fO3g-fRmj4aCeJP9ZkdzarWB8ge8oLpE5Cpg/viewform';

/**
Google Forms field ID helper.

To refresh entry IDs after modifying the form:

1. Open the Google Form in edit mode.
2. Open DevTools → Console.
3. Run the snippet below.

It prints each question title together with its corresponding `entry.xxxxxxxx` ID.

```js
document.querySelectorAll('[data-params]').forEach(field => {
const match = field.dataset.params?.match(/\[\[(\d+)/);
if (!match) return;

const title =
   field.querySelector('[role="heading"]')?.innerText ?? 'Unnamed field';

console.log(`${title}: entry.${match[1]}`);
});
```
*/

/**
 * Pre-filled entry IDs corresponding to Google Form questions.
 * @type {Readonly<Record<string, string>>}
 */
const GOOGLE_FORM_FIELDS = Object.freeze({
   TRACE_NAME: 'entry.35504208',
   STACK_TRACE: 'entry.151125768',
   URL: 'entry.744404568',
   VERSION_INFO: 'entry.1416921320',
   contact: 'entry.562105123',
});

// --- Private Helper Functions ---

/**
 * Safely truncates strings to prevent massive payloads
 */
const truncate = (str, limit = MAX_STRING_LENGTH) => {
   if (typeof str !== 'string') return str;
   return str.length > limit ? str.substring(0, limit) + '... [TRUNCATED]' : str;
};

/**
 * Safely stringifies and truncates context objects
 */
const safeSerializeContext = (context) => {
   try {
      const str = JSON.stringify(context);
      return truncate(str, MAX_STRING_LENGTH);
   } catch {
      return '[Unserializable Context]';
   }
};

/**
 * Constructs a structured, serializable diagnostic error entry with environmental metadata.
 *
 * @private
 * @param {Error|any} error - Captured exception object or error message value.
 * @param {Record<string, any>} [context={}] - Context details regarding where the exception occurred.
 * @returns {Record<string, any>} Serialized diagnostic error record.
 */
const createErrorEntry = (error, context = {}) => ({
   timestamp: new Date().toISOString(),
   message: truncate(error instanceof Error ? error.message : String(error ?? 'Unknown error')),
   stack: truncate(error?.stack ?? ''),
   context: safeSerializeContext(context),
   appVersion: APP_VERSION,
   userAgent: truncate(globalThis.navigator?.userAgent ?? 'N/A', 200),
   url: truncate(globalThis.location?.href ?? 'background', 500),
   language: globalThis.navigator?.language ?? 'N/A',
});

/**
 * Retrieves stored error records from local extension storage.
 * Guarantees an array return type even if storage is uninitialized or corrupted.
 *
 * @private
 * @returns {Promise<Array<Record<string, any>>>} Array of stored error entries.
 */
const getStoredErrors = async () => {
   try {
      const res = await browser?.storage?.local?.get(STORAGE_KEY);
      const errors = res?.[STORAGE_KEY];
      return Array.isArray(errors) ? errors : [];
   } catch (err) {
      console.error('[ErrorCollector] Failed to read stored errors:', err);
      return [];
   }
};

/**
 * Builds a pre-filled Google Form URL for reporting a captured error.
 *
 * @private
 * @param {Record<string, any>} errorEntry - Captured error entry.
 * @returns {string} Google Form URL with pre-filled diagnostic fields.
 */
function buildReportUrl(errorEntry) {
   try {
      const { context, stack, url, appVersion, userAgent, language } = errorEntry ?? {};

      // Parse context back if it was serialized
      let traceName = 'N/A';
      try {
         const parsedCtx = JSON.parse(context);
         traceName = parsedCtx?.trace_name ?? 'N/A';
      } catch { }

      const safeStack = truncate(stack || 'No stack trace available', 600);
      const safeUrl = truncate(url || 'N/A', 200);

      const params = new URLSearchParams({
         [GOOGLE_FORM_FIELDS.TRACE_NAME]: traceName,
         [GOOGLE_FORM_FIELDS.STACK_TRACE]: safeStack,
         [GOOGLE_FORM_FIELDS.URL]: safeUrl,
         [GOOGLE_FORM_FIELDS.VERSION_INFO]:
            `${appVersion ?? APP_VERSION} | ${userAgent ?? 'N/A'} [${language ?? 'N/A'}]`,
      });

      return `${GOOGLE_FORM_URL}?${params.toString()}`;
   } catch {
      return GOOGLE_FORM_URL;
   }
}

// --- Public API Functions ---

/**
 * Captures an exception with diagnostic context and persists it to local storage.
 * Maintains a rolling FIFO queue capped at MAX_ENTRIES (100) to protect extension storage quotas.
 *
 * @param {Error|any} error - The error object or exception value to record.
 * @param {Record<string, any>} [context={}] - Diagnostic context metadata.
 * @returns {Promise<Record<string, any>>} Resolves to the created diagnostic error entry.
 */
async function capture(error, context = {}) {
   try {
      const newEntry = createErrorEntry(error, context);
      const existingErrors = await getStoredErrors();

      // Maintain FIFO log buffer cap to prevent storage quota exhaustion
      const updatedErrors = [...existingErrors, newEntry].slice(-MAX_ENTRIES);

      await browser?.storage?.local?.set({ [STORAGE_KEY]: updatedErrors });

      const reportUrl = buildReportUrl(newEntry);

      // Print a clickable report link in DevTools for easier debugging
      console.error(
         `[ErrorCollector] Captured: ${newEntry.message}\n` +
         `👉 Report Issue: ${reportUrl}`,
         { entry: newEntry }
      );

      return newEntry;
   } catch (internalError) {
      console.error('[ErrorCollector] Internal capture failure:', internalError);
      // Return a minimal fallback record to avoid losing diagnostic information
      return { message: String(error) };
   }
}

/**
 * Opens a Google Form pre-filled with diagnostic error details for user feedback submission.
 * Note: Must be invoked from a window context (e.g. Popup, Options, or Editor page).
 *
 * @param {Record<string, any>} errorEntry - Formatted error entry returned by `capture`.
 */
function reportGoogleForm(errorEntry) {
   if (!globalThis.window || !globalThis.open) {
      console.warn('[ErrorCollector] Cannot open report form from non-window execution context.');
      return;
   }

   try {
      globalThis.open(buildReportUrl(errorEntry), '_blank');
   } catch (internalError) {
      console.error('[ErrorCollector] Failed to open Google Form:', internalError);
   }
}

/**
 * Clears all captured error entries from local storage.
 * @returns {Promise<void>}
 */
async function clearErrors() {
   try {
      await browser?.storage?.local?.remove(STORAGE_KEY);
   } catch (err) {
      console.error('[ErrorCollector] Failed to clear error logs:', err);
   }
}

/**
 * Returns a slice of the most recent error entries up to the requested limit.
 *
 * @param {number} [limit=10] - Maximum number of recent error records to retrieve.
 * @returns {Promise<Array<Record<string, any>>>} Promise resolving to array of recent error entries.
 */
async function getRecentErrors(limit = 10) {
   const allErrors = await getStoredErrors();
   return allErrors.slice(-limit);
}

/**
 * Generates a comprehensive markdown-formatted diagnostic report
 * for user feedback and debugging.
 *
 * @returns {Promise<string>} Formatted diagnostic report string.
 */
async function generateDiagnosticReport() {
   try {
      const recentErrors = await getRecentErrors(10);
      const manifest = browser?.runtime?.getManifest?.() || {};
      const settings = (await browser?.storage?.sync?.get('extension_settings'))?.extension_settings || {};

      const reportLines = [
         `### 🐵 Lite Monkey Diagnostic Report`,
         `**Timestamp:** ${new Date().toISOString()}`,
         `**App Version:** v${manifest.version || '0.0.0'}`,
         `**User Agent:** ${navigator.userAgent}`,
         `**Language:** ${navigator.language}`,
         ``,
         `#### ⚙️ Extension Preferences`,
         `\`\`\`json`,
         JSON.stringify(settings, null, 2),
         `\`\`\``,
         ``,
         `#### 🚨 Recent Error Logs (${recentErrors.length})`,
      ];

      if (recentErrors.length === 0) {
         reportLines.push(`*No system errors recorded.*`);
      } else {
         recentErrors.forEach((err, idx) => {
            reportLines.push(
               `\n**[Error #${idx + 1}]** \`${err.timestamp}\` - ${err.message}`,
               `*Context:* \`${err.context}\``,
               `\`\`\``,
               err.stack || 'No stack trace available',
               `\`\`\``
            );
         });
      }

      return reportLines.join('\n');
   } catch (fatal) {
      return `Failed to generate diagnostic report: ${fatal.message}`;
   }
}

/**
 * Centralized error collection and reporting system.
 */
export const ErrorCollector = Object.freeze({
   capture,
   /** @deprecated Use `capture`. Maintained for backward compatibility. */
   captureAndReport: capture,
   reportGoogleForm,
   getErrors: getStoredErrors,
   clearErrors,
   getRecentErrors,
   generateDiagnosticReport, // Export diagnostic report generator
});
