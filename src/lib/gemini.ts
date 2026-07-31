/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Gemini AI configuration - Server-side only.
 * This module should NOT be imported by client-side code.
 * 
 * For client-side AI operations, use the unifiedAI service which proxies
 * requests through the server.
 */

// This file is kept for server-side imports only.
// The actual AI client is now initialized in src/server/aiProvider.ts

export const MODELS = {
  FLASH: "gemini-3-flash-preview",
  LITE: "gemini-3.1-flash-lite-preview",
  PRO: "gemini-3.1-pro-preview",
  TTS: "gemini-2.5-flash-preview-tts",
};
