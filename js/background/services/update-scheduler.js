import browser from '../../libs/browser-support.js';
import UpdateService from './update-service.js';
import { logger } from '../../libs/logger.js';
import { DEFAULT_SETTINGS } from '../../constants.js';

const CONTEXT = 'UpdateScheduler';
const ALARM_NAME = 'script-update-check';

/**
 * Schedules periodic automatic userscript update checks using WebExtension Alarms API.
 */
class UpdateScheduler {
   /**
    * Initializes the update scheduler by registering the alarm listener and scheduling the initial alarm.
    */
   initialize() {
      browser.alarms.onAlarm.addListener((alarm) => this._onAlarmTriggered(alarm));
      logger.debug(CONTEXT, 'Initialized');
      return this.scheduleUpdateCheck().catch((err) => {
         logger.error(CONTEXT, 'Failed to schedule initial update check:', err);
      });
   }

   /**
    * Handles browser alarm triggers and executes update check if the alarm identifier matches.
    * @private
    * @param {Object} alarm - WebExtension Alarm object.
    * @returns {Promise<void>}
    */
   async _onAlarmTriggered(alarm) {
      if (alarm.name === ALARM_NAME) {
         logger.debug(CONTEXT, 'Alarm triggered, starting automatic update check...');
         try {
            await UpdateService.checkForUpdates();
         } catch (err) {
            logger.error(CONTEXT, 'Automatic update check failed:', err);
         }
      }
   }

   /**
    * Reads user preferences from sync storage and schedules or cancels periodic update alarms.
    * @returns {Promise<void>}
    */
   async scheduleUpdateCheck() {
      const data = await browser.storage.sync.get('extension_settings');

      // Guarantee fallback property fallback via explicit object merge
      const settings = { ...DEFAULT_SETTINGS, ...(data?.extension_settings || {}) };

      // Safely parse and validate numeric interval to prevent NaN Service Worker crashes
      const parsedInterval = parseInt(settings.autoUpdateIntervalDays, 10);
      const intervalDays = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 0;

      if (intervalDays <= 0) {
         await browser.alarms.clear(ALARM_NAME);
         logger.debug(CONTEXT, 'Automatic updates are disabled. Alarm cleared.');
         return;
      }

      const targetPeriodMinutes = intervalDays * 24 * 60;

      // Check if alarm already exists to prevent Service Worker restart timer loops
      const existingAlarm = await browser.alarms.get(ALARM_NAME);
      if (existingAlarm && existingAlarm.periodInMinutes === targetPeriodMinutes) {
         logger.debug(CONTEXT, `Update alarm already scheduled every ${intervalDays} day(s). Keeping active timer.`);
         return;
      }

      // Re-create alarm only if interval setting changed or alarm was missing
      await browser.alarms.clear(ALARM_NAME);
      browser.alarms.create(ALARM_NAME, {
         delayInMinutes: 5,
         periodInMinutes: targetPeriodMinutes,
      });
      logger.debug(CONTEXT, `Update check scheduled every ${intervalDays} day(s).`);
   }
}

// WARNING: Exported as a singleton default instance. Maintain default import syntax in consumers.
export default new UpdateScheduler();
