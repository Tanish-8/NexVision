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
/**
 * Safely parses the physical pixel dimensions from a PNG base64 data URL.
 * Reads the IHDR chunk width and height directly from the first 24 bytes
 * without decoding the full image payload. Returns undefined if not a valid PNG.
 */
export function extractPngDimensions(
  dataUrl: string
): { width: number; height: number } | undefined {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return undefined;
  }
  try {
    const base64Header = dataUrl.slice(22, 58);
    const binary =
      typeof atob === 'function'
        ? atob(base64Header)
        : Buffer.from(base64Header, 'base64').toString('binary');
    if (binary.length >= 24) {
      const bytes = new Uint8Array(24);
      for (let i = 0; i < 24; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const view = new DataView(bytes.buffer);
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
  } catch {
    // Non-critical: safe fallback to undefined
  }
  return undefined;
}

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

  const dimensions = format === 'png' ? extractPngDimensions(dataUrl) : undefined;

  return {
    dataUrl,
    format,
    timestamp: Date.now(),
    ...(dimensions ? { dimensions } : {})
  };
}

