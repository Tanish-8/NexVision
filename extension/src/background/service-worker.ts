/**
 * Background service worker for SIH26171 extension.
 * Coordinates between popup and content script.
 */

import { MessageType } from '../shared/types.js';
import { sendToTab, MessageRouter } from '../shared/messaging.js';
import type { ExtensionMessage, ExtensionResponse } from '../shared/types.js';
import type {
  PageRepresentation,
  ScreenshotCaptureOptions,
  ScreenshotCaptureResult,
  UnifiedPerceptionRequest
} from '../shared/types.js';
import { captureVisibleTab } from './screenshot.js';
import { perceivePage } from './orchestrator.js';
import type {
  DomPerceptionProvider,
  ScreenshotProvider,
  VisualPerceptionAdapter,
  VisualObservation,
  UnifiedPerceptionResult
} from './orchestrator.js';

const router = new MessageRouter();

/**
 * Log when service worker starts
 */
console.log('[SIH26171] Background service worker started');

/**
 * Handle messages from popup — forwards DOM inspection request to content script.
 */
router.register(MessageType.INSPECT_PAGE_REQUEST, async (
  payload: any,
  _sender: chrome.runtime.MessageSender
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
 * DOM IPC timeout in milliseconds.
 * Prevents indefinite hangs when the content script is absent or unresponsive.
 */
export const DOM_IPC_TIMEOUT_MS = 5000;

/**
 * Create an async DOM perception provider that retrieves PageRepresentation
 * from the content script running in the given tab via IPC.
 *
 * Reuses the existing INSPECT_PAGE_REQUEST / sendToTab path that content-script.ts
 * already handles — no new message type is required.
 *
 * Throws on:
 * - Content script absent or unresponsive (response.success === false)
 * - IPC timeout (DOM_IPC_TIMEOUT_MS exceeded)
 * - Unexpected messaging transport errors
 *
 * The caller (perceivePage) catches these throws and maps them to origin 'dom'.
 */
export function createDomProvider(tabId: number): DomPerceptionProvider {
  return async (): Promise<PageRepresentation> => {
    const ipcPromise = sendToTab<PageRepresentation>(
      tabId,
      MessageType.INSPECT_PAGE_REQUEST
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`DOM perception timed out after ${DOM_IPC_TIMEOUT_MS}ms`)),
        DOM_IPC_TIMEOUT_MS
      )
    );

    let response: ExtensionResponse<PageRepresentation>;
    try {
      response = await Promise.race([ipcPromise, timeoutPromise]);
    } catch (error) {
      // Covers timeout and any sendToTab transport errors
      throw error instanceof Error
        ? error
        : new Error('DOM perception IPC failed');
    }

    if (!response.success || response.data == null) {
      throw new Error(response.error ?? 'Content script returned failure for DOM perception');
    }

    return response.data;
  };
}

/**
 * Minimal local null implementation of VisualPerceptionAdapter.
 * Always returns zero observations (success).
 *
 * Phase 2D runtime adapter — enables the full pipeline without a real vision model.
 * Replace with a real adapter in a future phase.
 *
 * Declared locally to preserve the extension TypeScript project boundary
 * (extension/tsconfig.json rootDir: ./src). The vision workspace is NOT imported here.
 */
const nullVisionAdapter: VisualPerceptionAdapter = {
  name: 'NullVisionAdapter',
  async perceive(_input) {
    return {
      success: true,
      observations: [] as VisualObservation[]
    };
  }
};

/**
 * Handle screenshot capture requests.
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
 * Handle unified perception requests (Phase 2D).
 *
 * Orchestrates DOM perception (via content-script IPC), screenshot capture,
 * and vision processing into a single UnifiedPerceptionResult using the Phase 2C
 * perceivePage() orchestrator.
 *
 * NOTE: CSS viewport dimensions (from DOM perception) are used as image dimensions
 * passed to the vision adapter. On high-DPI displays, captureVisibleTab captures at
 * physical device pixel dimensions (e.g. 2× on Retina). DOM CSS-pixel coordinates
 * versus screenshot physical-pixel coordinates may differ; coordinate normalization
 * is deferred to Phase 3.
 *
 * Privacy guarantees:
 * - Screenshot dataUrl is NOT forwarded in the result (stripped by perceivePage).
 * - No form values, passwords, cookies, localStorage, or sessionStorage are read.
 */
router.register(MessageType.UNIFIED_PERCEPTION_REQUEST, async (
  _payload: UnifiedPerceptionRequest | undefined,
  _sender: chrome.runtime.MessageSender
): Promise<ExtensionResponse<UnifiedPerceptionResult>> => {
  try {
    const activeTab = await getActiveTab();

    if (!activeTab?.id) {
      return {
        success: false,
        error: 'No active tab found'
      };
    }

    const domProvider: DomPerceptionProvider = createDomProvider(activeTab.id);

    const screenshotProvider: ScreenshotProvider = async () => {
      // captureVisibleTab uses activeTab.windowId; this is set by getActiveTab().
      const result = await captureVisibleTab(activeTab.windowId);
      return {
        format: result.format,
        timestamp: result.timestamp,
        dataUrl: result.dataUrl  // passed to vision adapter; NOT forwarded in final result
      };
    };

    const result = await perceivePage(domProvider, screenshotProvider, nullVisionAdapter);

    return {
      success: true,
      data: result
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unified perception failed'
    };
  }
});

/**
 * Register Chrome runtime listeners.
 * Guarded so the module can be imported in test environments where
 * chrome is not defined at module load time. The exported helper
 * functions (createDomProvider, DOM_IPC_TIMEOUT_MS, nullVisionAdapter)
 * are always available regardless of this guard.
 */
if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
  /**
   * Listen for messages from popup / other extension pages.
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
   * Handle extension installation/update.
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
   * Notify popup that extension is ready.
   */
  chrome.runtime.onStartup.addListener(() => {
    console.log('[SIH26171] Extension started');
  });
}
