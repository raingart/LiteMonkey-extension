/**
 * @file Background Service Worker Entry Point
 * @description Serves as the main entry point for the Lite Monkey Chrome Extension service worker (Manifest V3).
 * Initializes all core services and background managers in a strict, dependency-aware tiered sequence
 * to prevent race conditions and ensure event listeners attach before IPC events arrive.
 */

import AppLifecycle from './core/app-lifecycle.js';
import MessageRouter from './core/message-router.js';
import CacheManager from './services/cache-manager.js';
import ApiHandler from './services/gm-api-handler.js';
import BadgeManager from './services/badge-manager.js';
import LogManager from './services/log-manager.js';
import StyleInjector from './services/style-injector.js';
import UpdateScheduler from './services/update-scheduler.js';
import UserScriptInterceptor from './services/userscript-interceptor.js';
import { logger } from '../libs/logger.js';

const LOG_CONTEXT = 'Background.Main';

/**
 * Service initialization tiers arranged in strict dependency order.
 * Tiers execute sequentially; services within a tier execute concurrently.
 *
 * Tier 0: Essential logging and diagnostic tools.
 * Tier 1: Core infrastructure and event listeners (listeners must attach immediately on SW wake).
 * Tier 2: Storage and RAM cache layer (must be populated before feature services query data).
 * Tier 3: High-level UI, badge notifications, log managers, and background schedulers.
 */
const initializationTiers = [
   // Tier 0: Diagnostic tools
   [logger],
   // Tier 1: Core infrastructure & browser event listeners
   [AppLifecycle, MessageRouter, UserScriptInterceptor, ApiHandler],
   // Tier 2: Storage & data cache layer
   [CacheManager],
   // Tier 3: Feature services & background workers
   [StyleInjector, BadgeManager, UpdateScheduler, LogManager],
];

/**
 * Initializes all services within a single tier concurrently.
 * Safely handles both synchronous and asynchronous `initialize()` implementations.
 *
 * @param {Array<{ initialize?: () => (Promise<void>|void) }>} services Service modules in the tier.
 * @returns {Promise<void[]>} Promise resolving when all service initializations in the tier complete.
 */
const initializeTier = (services) => {
   const initializations = services.map((service) => {
      if (typeof service?.initialize === 'function') {
         return service.initialize();
      }
      return undefined;
   });
   return Promise.all(initializations);
};

/**
 * Main entry point function for the Service Worker.
 * Sequentially initializes each tier to respect dependency constraints.
 */
async function main() {
   try {
      for (const tier of initializationTiers) {
         await initializeTier(tier);
      }
      logger.info(LOG_CONTEXT, 'Application initialized successfully.');
   } catch (error) {
      logger.error(LOG_CONTEXT, 'Initialization failed.', error);
   }
}

// Execute Service Worker startup sequence
main();
