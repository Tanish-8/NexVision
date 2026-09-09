/**
 * Local screenshot capture helper for SIH26171 extension.
 * Captures the visible viewport of a browser window via chrome.tabs.captureVisibleTab.
 *
 * Ephemeral and in-memory only.
 * No DOM access, no permanent storage, no network transmission, no sensitive data leakage.
 */

import type { ScreenshotCaptureOptions, ScreenshotCaptureResult } from '../shared/types.js';

/**
 * Capture the visible browser viewport as an ephemeral in-memory screenshot.
 *
 * @param windowId Target window ID. Defaults to current window if undefined.
 * @param options Capture options specifying image format ('png' | 'jpeg') and quality (0-100).
 * @returns Promise resolving to the minimal ScreenshotCaptureResult.
 * @throws Error if capture fails, rate limit is exceeded, or the API is unavailable.
 */
export async function captureVisibleTab(
  windowId?: number,
  options?: ScreenshotCaptureOptions
): Promise<ScreenshotCaptureResult> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.captureVisibleTab) {
    throw new Error('Screenshot capture failed: chrome.tabs.captureVisibleTab API is not available');
  }

  const format = options?.format === 'jpeg' ? 'jpeg' : 'png';
  const details: chrome.extensionTypes.ImageDetails = {
    format
  };

  if (format === 'jpeg' && typeof options?.quality === 'number') {
    details.quality = Math.max(0, Math.min(100, Math.round(options.quality)));
  }

  let dataUrl: string;
  try {
    if (typeof windowId === 'number') {
      dataUrl = await chrome.tabs.captureVisibleTab(windowId, details);
    } else {
      dataUrl = await chrome.tabs.captureVisibleTab(details);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Screenshot capture failed: ${message}`);
  }

  if (!dataUrl) {
    throw new Error('Screenshot capture failed: No image data returned');
  }

  return {
    dataUrl,
    format,
    timestamp: Date.now()
  };
}

