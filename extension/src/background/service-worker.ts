/**
 * Background service worker for SIH26171 extension.
 * Coordinates between popup and content script.
 */

import { MessageType } from '../shared/types.js';
import { sendToBackground, sendToTab, MessageRouter } from '../shared/messaging.js';
import type { ExtensionMessage, ExtensionResponse, PageSnapshot } from '../shared/types.js';
import type { PageRepresentation, ScreenshotCaptureOptions, ScreenshotCaptureResult } from '../shared/types.js';
import { captureVisibleTab } from './screenshot.js';

const router = new MessageRouter();

/**
 * Log when service worker starts
 */
console.log('[SIH26171] Background service worker started');

/**
 * Handle messages from popup
 */
router.register(MessageType.INSPECT_PAGE_REQUEST, async (
  payload: any,
  sender: chrome.runtime.MessageSender
): Promise<ExtensionResponse> => {
  try {
    // Get the active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab?.id) {
      return {
        success: false,
        error: 'No active tab found'
      };
    }

    // Send request to content script in the active tab
    const response = await sendToTab<PageRepresentation>(
      activeTab.id,
      MessageType.INSPECT_PAGE_REQUEST,
      payload
    );

    return response;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Background error'
    };
  }
});

/**
 * Resolves the active browser tab, even when an extension DevTools window is focused.
 */
async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  // 1. Query active tab in the last focused window
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs[0]) return tabs[0];

  // 2. Query active tab in the current window
  tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) return tabs[0];

  // 3. When DevTools is focused, find the last focused normal browser window
  if (typeof chrome.windows?.getLastFocused === 'function') {
    try {
      const normalWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (normalWindow?.id) {
        tabs = await chrome.tabs.query({ active: true, windowId: normalWindow.id });
        if (tabs[0]) return tabs[0];
      }
    } catch {
      // Fall through to normal window query
    }
  }

  // 4. Query active tab in any normal browser window
  tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
  if (tabs[0]) return tabs[0];

  // 5. Fallback to any active tab
  tabs = await chrome.tabs.query({ active: true });
  return tabs[0];
}

/**
 * Handle screenshot capture requests
 */
router.register(MessageType.CAPTURE_SCREENSHOT_REQUEST, async (
  payload: ScreenshotCaptureOptions | undefined,
  _sender: chrome.runtime.MessageSender
): Promise<ExtensionResponse<ScreenshotCaptureResult>> => {
  try {
    const activeTab = await getActiveTab();

    if (!activeTab) {
      return {
        success: false,
        error: 'No active tab found'
      };
    }

    const result = await captureVisibleTab(activeTab.windowId, payload);
    return {
      success: true,
      data: result
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Screenshot capture failed'
    };
  }
});

/**
 * Listen for messages from popup
 */
chrome.runtime.onMessage.addListener(
  <T = any>(message: ExtensionMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: ExtensionResponse) => void) => {
    router.route(message, sender).then((response) => {
      if (sendResponse) {
        sendResponse(response);
      }
    });
    // Return true to indicate we'll respond asynchronously
    return true;
  }
);

/**
 * Handle extension installation/update
 */
chrome.runtime.onInstalled.addListener(({ reason }) => {
  switch (reason) {
    case 'install':
      console.log('[SIH26171] Extension installed');
      break;
    case 'update':
      console.log('[SIH26171] Extension updated');
      break;
  }
});

/**
 * Notify popup that extension is ready
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('[SIH26171] Extension started');
});
