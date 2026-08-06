import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LOG_LEVELS, logger } from '../js/libs/logger.js';

describe('Logger Module Tests (logger.js)', () => {
   it('should define distinct numeric priority levels', () => {
      assert.equal(LOG_LEVELS.ERROR, 0);
      assert.equal(LOG_LEVELS.WARN, 1);
      assert.equal(LOG_LEVELS.INFO, 2);
      assert.equal(LOG_LEVELS.DEBUG, 3);
   });

   it('should provide callable debug, info, warn, and error methods', () => {
      assert.equal(typeof logger.debug, 'function');
      assert.equal(typeof logger.info, 'function');
      assert.equal(typeof logger.warn, 'function');
      assert.equal(typeof logger.error, 'function');
   });

   it('should execute logger methods without throwing exceptions in Node environment', () => {
      assert.doesNotThrow(() => {
         logger.info('TestContext', 'Test log message', { a: 1 });
         logger.warn('TestContext', 'Warning message');
         logger.error('TestContext', 'Error message');
      });
   });
});
