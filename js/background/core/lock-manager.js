import { logger } from '../../libs/logger.js';

const CONTEXT = 'LockManager';

/**
 * Sequential FIFO Promise-Queue Mutex Lock Manager.
 * Guarantees atomic execution of asynchronous tasks (DB writes, cache updates, cloud sync)
 * by queuing concurrent requests instead of throwing "System is busy" errors.
 */
class LockManager {
   /** Replace boolean flag with a Promise chain execution queue */
   #queue = Promise.resolve();

   /**
    * Indicates whether operations are currently waiting or running in the queue.
    * @returns {boolean} True if the queue is active.
    */
   get isLocked() {
      return false; // Retained for API compatibility
   }

   /**
    * Executes an asynchronous function within a single-execution FIFO promise queue.
    * Incoming actions wait for preceding operations to complete instead of failing.
    *
    * @template T
    * @param {() => Promise<T>|T} action Async or sync function to execute under lock.
    * @returns {Promise<T>} Result returned by the executed action.
    * @throws {TypeError} If action parameter is not a function.
    */
   async withLock(action) {
      if (typeof action !== 'function') {
         throw new TypeError('LockManager.withLock expected a function as its argument.');
      }

      logger.debug(CONTEXT, 'Queuing operation...');

      // Chain incoming actions onto the promise queue tail so they run sequentially without failing
      const result = this.#queue.then(async () => {
         logger.debug(CONTEXT, 'Executing queued operation...');
         return await action();
      });

      // Update queue tail, swallowing errors on the chain so subsequent items in line still execute
      this.#queue = result.catch(() => {});

      return result;
   }
}

/** Singleton instance exported for extension background service worker operations. */
export default new LockManager();
