import browser from './browser-support.js';
import { MSG } from '../message-types.js';
import { logger } from './logger.js';

const CONTEXT = 'MessageService';
const RETRY_DELAY_MS = 150;
const SERVICE_WORKER_TERMINATED_MSG = 'Receiving end does not exist';

/**
 * Sends a message to the background Service Worker, automatically retrying once if
 * Chrome MV3 has terminated the inactive Service Worker context.
 *
 * Background Context Workaround:
 * In Manifest V3, Chrome automatically terminates background Service Workers after ~30 seconds
 * of inactivity. When a message is sent to an inactive Service Worker, Chrome rejects the initial
 * call with "Receiving end does not exist" while spinning up the background process. Sending a
 * lightweight PING and delaying 150ms grants the worker time to re-initialize before re-dispatching.
 *
 * @param {Record<string, any>} message - The message payload object (must contain a `type` property).
 * @returns {Promise<any>} Response returned from the Service Worker listener.
 * @throws {Error|any} Re-throws the message transmission error if it fails after retry or is unrelated to worker termination.
 */
export async function sendMessageWithRetry(message) {
   try {
      return await browser.runtime.sendMessage(message);
   } catch (error) {
      const errorMessage = error?.message ?? String(error);

      if (errorMessage.includes(SERVICE_WORKER_TERMINATED_MSG)) {
         const messageType = message?.type ?? 'UNKNOWN_TYPE';
         logger.debug(
            CONTEXT,
            `Service Worker inactive for message "${messageType}". Waking and retrying...`
         );

         // Dispatch a fire-and-forget PING to trigger Chrome's Service Worker wake-up routine
         browser.runtime.sendMessage({ type: MSG.PING }).catch(() => {
            // Silently swallow rejection from the wake-up attempt
         });

         // Allow background context execution loop to initialize before retrying original message
         await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

         return await browser.runtime.sendMessage(message);
      }

      throw error;
   }
}
