/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Production-safe logger that strips console output in production builds.
 */

const isDevelopment = process.env.NODE_ENV === 'development' || 
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV);

/**
 * Development-only logger. All output is stripped in production builds.
 */
export const logger = {
  log: (...args: any[]) => {
    if (isDevelopment) {
      console.log('[TechPulse]', ...args);
    }
  },
  
  warn: (...args: any[]) => {
    if (isDevelopment) {
      console.warn('[TechPulse]', ...args);
    }
  },
  
  error: (...args: any[]) => {
    // Errors are always logged (but could be sent to error tracking service)
    console.error('[TechPulse]', ...args);
  },
  
  debug: (...args: any[]) => {
    if (isDevelopment) {
      console.debug('[TechPulse]', ...args);
    }
  },
  
  info: (...args: any[]) => {
    if (isDevelopment) {
      console.info('[TechPulse]', ...args);
    }
  }
};
