/**
 * Background service worker for SIH26171 extension.
 * Coordinates between popup and content script.
 */

import { MessageType } from '../shared/types.js';
import { sendToTab, MessageRouter, dispatchMessageToRouter } from '../shared/messaging.js';
import type {
  ExtensionMessage,
  ExtensionResponse,
  PageRepresentation,
  ScreenshotCaptureOptions,
  ScreenshotCaptureResult,
  UnifiedPerceptionRequest,
  ExecuteActionRequest,
  ExecutionResult,
  RunAgentStepRequest,
  StartAgentRequest,
  StartAgentResponseData,
  AgentProgressEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  GetAgentStatusResponseData,
  ChatRequest,
  ChatResponseData,
  CheckHealthResponseData
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
import { createLlamaVisionAdapter } from './llamaVisionAdapter.js';
import { runDemoAgentWithProvider } from './demoRunner.js';
import type { DemoRunResult, DemoStep } from './demoRunner.js';
import { executeAction } from './executor.js';
import { DefaultLocalLlamaChatClient } from './localAgent.js';
import { sanitizePageRepresentation } from '../privacy/sanitizer.js';
import {
  isRestrictedUrl,
  buildRestrictedPageContext,
  buildUnavailablePageContext,
  buildPageChatContext,
  buildChatUserPrompt,
  CHAT_SYSTEM_PROMPT
} from './chatContext.js';


export const router = new MessageRouter();

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
export async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  // 1. Query active tab in the last focused normal browser window
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
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
 * Determines whether an IPC error indicates that the content script is missing
 * or the communication channel could not be established (recoverable transport failure).
 *
 * Does NOT match application-level extraction errors returned by the content script.
 */
export function isMissingReceiverError(errorMsg?: string): boolean {
  if (!errorMsg || typeof errorMsg !== 'string') return false;
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes('could not establish connection') ||
    lower.includes('receiving end does not exist') ||
    lower.includes('message port closed') ||
    lower.includes('connection reset') ||
    lower.includes('frame with id') ||
    lower.includes('recipient does not exist') ||
    lower.includes('no tab with id')
  );
}

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
  async function getPageRepresentation(): Promise<PageRepresentation> {
    let response: ExtensionResponse<PageRepresentation>;
    try {
      response = await sendToTab<PageRepresentation>(
        tabId,
        MessageType.INSPECT_PAGE_REQUEST
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      response = { success: false, error: msg };
    }

    if (response.success && response.data != null) {
      return response.data;
    }

    const initialError = response.error ?? 'Content script returned failure for DOM perception';

    // If it's NOT a missing receiver transport failure, it's an application-level error
    // (e.g. DOM extraction failure): preserve and throw the original error without reinjection.
    if (!isMissingReceiverError(initialError)) {
      throw new Error(initialError);
    }

    // Recoverable transport failure (receiver missing): attempt injection if scripting API is available
    if (typeof chrome === 'undefined' || !(chrome as any)?.scripting?.executeScript) {
      throw new Error(initialError);
    }

    // Restrict injection on unscriptable browser schemes
    if (typeof chrome !== 'undefined' && chrome?.tabs?.get) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url && (
          tab.url.startsWith('chrome://') ||
          tab.url.startsWith('chrome-extension://') ||
          tab.url.startsWith('edge://') ||
          tab.url.startsWith('devtools://') ||
          tab.url.startsWith('view-source:') ||
          tab.url.startsWith('about:')
        )) {
          throw new Error(`Cannot inject content script into restricted URL: ${tab.url}`);
        }
      } catch (tabErr: unknown) {
        if (tabErr instanceof Error && tabErr.message.includes('Cannot inject')) {
          throw tabErr;
        }
        // If tabs.get is unavailable or tab doesn't have URL, proceed with executeScript
      }
    }

    // Programmatically inject content script
    try {
      await (chrome as any).scripting.executeScript({
        target: { tabId },
        files: ['content/content-script.js']
      });
    } catch (injectErr: unknown) {
      const msg = injectErr instanceof Error ? injectErr.message : String(injectErr);
      throw new Error(`Failed to inject content script: ${msg}`);
    }

    // Bounded readiness verification retry (up to 3 attempts with exponential backoff)
    const READINESS_DELAYS_MS = [25, 50, 100];
    let retryResponse: ExtensionResponse<PageRepresentation> | undefined;

    for (const delay of READINESS_DELAYS_MS) {
      await new Promise(r => setTimeout(r, delay));

      try {
        retryResponse = await sendToTab<PageRepresentation>(
          tabId,
          MessageType.INSPECT_PAGE_REQUEST
        );
      } catch (retryErr: unknown) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        retryResponse = { success: false, error: msg };
      }

      if (retryResponse.success && retryResponse.data != null) {
        return retryResponse.data;
      }

      // If it returned an explicit application error, stop retrying immediately
      if (!isMissingReceiverError(retryResponse.error)) {
        throw new Error(retryResponse.error ?? 'Content script returned failure for DOM perception after injection');
      }
    }

    throw new Error(retryResponse?.error ?? 'Content script failed to respond after injection');
  }

  return async (): Promise<PageRepresentation> => {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error(`DOM perception timed out after ${DOM_IPC_TIMEOUT_MS}ms`)),
        DOM_IPC_TIMEOUT_MS
      );
    });

    const ipcPromise = getPageRepresentation();

    try {
      return await Promise.race([ipcPromise, timeoutPromise]);
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
      // Attach no-op error handler to suppress unhandled rejections if ipcPromise settles after timeout
      ipcPromise.catch(() => {});
    }
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
export const nullVisionAdapter: VisualPerceptionAdapter = {
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
 * Handle unified perception requests (Phase 2D / Phase 2E-2B).
 *
 * Orchestrates DOM perception (via content-script IPC), screenshot capture,
 * and vision processing into a single UnifiedPerceptionResult using the Phase 2C
 * perceivePage() orchestrator with Phase 2E-2B real local llama.cpp vision adapter.
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
        dataUrl: result.dataUrl,  // passed to vision adapter; NOT forwarded in final result
        dimensions: result.dimensions
      };
    };

    const visionAdapter = createLlamaVisionAdapter();
    const result = await perceivePage(domProvider, screenshotProvider, visionAdapter);

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
 * Handle action execution requests.
 */
router.register<ExecuteActionRequest>(MessageType.EXECUTE_ACTION_REQUEST, async (
  payload: ExecuteActionRequest,
  _sender: chrome.runtime.MessageSender
): Promise<ExtensionResponse<ExecutionResult>> => {
  try {
    const result = await executeAction(payload);
    return {
      success: true,
      data: result
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Action execution failed'
    };
  }
});

/**
 * Broadcast an event to extension listeners (popup, sidepanel, options).
 * Safely catches any rejections if no receiver is currently open.
 */
function broadcastEvent<T>(type: string, payload: T): void {
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type, payload }).catch(() => {
        // Safe: popup or listener might not be open right now
      });
    }
  } catch {
    // Ignore runtime unavailable errors
  }
}

interface AgentRunState {
  runId: string;
  active: boolean;
  status: string;
  steps: DemoStep[];
  result?: DemoRunResult;
  lastError?: string;
  startedAt: number;
}

let currentAgentRun: AgentRunState | null = null;

/**
 * Heartbeat interval in milliseconds to keep the MV3 Service Worker alive
 * during long-running background local inference.
 *
 * Chromium MV3 service workers terminate after ~30 seconds of inactivity.
 * Periodic calls to chrome.* APIs reset the idle timer.
 */
export const KEEPALIVE_INTERVAL_MS = 15000;

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Returns true if the agent keepalive heartbeat is currently active.
 */
export function isAgentKeepaliveActive(): boolean {
  return keepaliveTimer !== null;
}

/**
 * Starts the keepalive heartbeat timer if not already active.
 * Periodically calls chrome.runtime.getPlatformInfo() while an agent run is active.
 */
export function startAgentKeepalive(intervalMs: number = KEEPALIVE_INTERVAL_MS): void {
  if (keepaliveTimer !== null) {
    return; // Prevent duplicate keepalive intervals
  }

  keepaliveTimer = setInterval(() => {
    if (!currentAgentRun || !currentAgentRun.active) {
      stopAgentKeepalive();
      return;
    }

    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
        const promise = chrome.runtime.getPlatformInfo();
        if (promise && typeof (promise as any).catch === 'function') {
          (promise as Promise<any>).catch(() => {});
        }
      }
    } catch {
      // Ignore heartbeat errors
    }
  }, intervalMs);
}

/**
 * Stops and clears the keepalive heartbeat timer.
 */
export function stopAgentKeepalive(): void {
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

/**
 * Test helper to reset current agent run state and keepalive.
 */
export function _resetAgentRunStateForTesting(): void {
  stopAgentKeepalive();
  currentAgentRun = null;
}

/**
 * Handle asynchronous, job-based agent run requests (START_AGENT_REQUEST).
 *
 * Responds IMMEDIATELY with an acknowledgment and runId (<2ms) so the
 * original sendResponse channel is never kept pending across long-running LLM inference.
 *
 * Bounded execution (runDemoAgentWithProvider) continues independently in the background,
 * broadcasting AGENT_PROGRESS_EVENT, AGENT_COMPLETED_EVENT, or AGENT_FAILED_EVENT.
 */
router.register<StartAgentRequest>(MessageType.START_AGENT_REQUEST, async (
  payload: StartAgentRequest,
  _sender: chrome.runtime.MessageSender
): Promise<ExtensionResponse<StartAgentResponseData>> => {
  try {
    // Prevent multiple concurrent agent runs
    if (currentAgentRun && currentAgentRun.active) {
      return {
        success: false,
        error: 'An agent run is already in progress',
        data: {
          runId: currentAgentRun.runId,
          startedAt: currentAgentRun.startedAt
        }
      };
    }

    let tabId = payload?.tabId;
    let windowId = payload?.windowId;

    if (tabId === undefined) {
      const activeTab = await getActiveTab();
      tabId = activeTab?.id;
      windowId = activeTab?.windowId;
    }

    if (typeof tabId !== 'number' || isNaN(tabId)) {
      return { success: false, error: 'No active tab found for demo agent' };
    }

    const runId = (payload?.runId && typeof payload.runId === 'string' && payload.runId.trim())
      ? payload.runId.trim()
      : `agent-run-${Date.now()}`;
    const startedAt = Date.now();
    const goalDescription = (payload?.goalDescription ?? '').trim() ||
      'Search for laptops under ₹50,000';

    currentAgentRun = {
      runId,
      active: true,
      status: 'STARTING',
      steps: [],
      startedAt
    };

    // Start keepalive heartbeat while agent run is active
    startAgentKeepalive();

    // Run agent asynchronously in background without awaiting in the response handler
    (async () => {
      try {
        const domProvider: DomPerceptionProvider = createDomProvider(tabId);
        const result = await runDemoAgentWithProvider(
          tabId,
          windowId,
          goalDescription,
          domProvider,
          (progress: AgentProgressEvent) => {
            if (currentAgentRun && currentAgentRun.runId === runId) {
              currentAgentRun.status = `${progress.phase}:${progress.status}`;
            }
            broadcastEvent(MessageType.AGENT_PROGRESS_EVENT, progress);
          },
          runId
        );

        if (currentAgentRun && currentAgentRun.runId === runId) {
          currentAgentRun.active = false;
          currentAgentRun.status = result.status;
          currentAgentRun.steps = [...result.steps];
          currentAgentRun.result = result;
        }

        broadcastEvent<AgentCompletedEvent>(MessageType.AGENT_COMPLETED_EVENT, {
          runId,
          result,
          timestamp: Date.now()
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Agent run failed unexpectedly';
        if (currentAgentRun && currentAgentRun.runId === runId) {
          currentAgentRun.active = false;
          currentAgentRun.status = 'FAILED';
          currentAgentRun.lastError = errorMsg;
        }

        broadcastEvent<AgentFailedEvent>(MessageType.AGENT_FAILED_EVENT, {
          runId,
          error: errorMsg,
          steps: currentAgentRun?.steps ?? [],
          timestamp: Date.now()
        });
      } finally {
        stopAgentKeepalive();
      }
    })();

    // Immediate acknowledgment
    return {
      success: true,
      data: {
        runId,
        startedAt
      }
    };
  } catch (error) {
    if (currentAgentRun && currentAgentRun.active) {
      currentAgentRun.active = false;
    }
    stopAgentKeepalive();
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start demo agent'
    };
  }
});

/**
 * Handle agent status query requests (GET_AGENT_STATUS_REQUEST).
 * Allows popup to immediately inspect the current or latest agent run upon reopening.
 */
router.register(MessageType.GET_AGENT_STATUS_REQUEST, async (): Promise<ExtensionResponse<GetAgentStatusResponseData>> => {
  if (!currentAgentRun) {
    return {
      success: true,
      data: { active: false }
    };
  }
  return {
    success: true,
    data: {
      active: currentAgentRun.active,
      runId: currentAgentRun.runId,
      status: currentAgentRun.status,
      steps: currentAgentRun.steps,
      lastError: currentAgentRun.lastError
    }
  };
});

/**
 * Handle bounded demo agent run requests (RUN_AGENT_STEP_REQUEST).
 *
 * Chains: perceivePage → sanitize → ground → planNextStep(LocalAgentDriver)
 *         → executeAction → (repeat ≤ MAX_STEPS).
 *
 * Privacy invariants: sanitizePageRepresentation() is called inside
 * runDemoAgentWithProvider() before any data reaches the model.
 */
router.register<RunAgentStepRequest>(MessageType.RUN_AGENT_STEP_REQUEST, async (
  payload: RunAgentStepRequest,
  _sender: chrome.runtime.MessageSender
): Promise<ExtensionResponse> => {
  try {
    const activeTab = await getActiveTab();

    if (!activeTab?.id) {
      return { success: false, error: 'No active tab found for demo agent' };
    }

    const domProvider: DomPerceptionProvider = createDomProvider(activeTab.id);
    const goalDescription = (payload?.goalDescription ?? '').trim() ||
      'Search for laptops under ₹50,000';

    const result = await runDemoAgentWithProvider(
      activeTab.id,
      activeTab.windowId,
      goalDescription,
      domProvider
    );

    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Demo agent failed'
    };
  }
});

/**
 * Handle health check requests for the local llama-server.
 */
router.register(MessageType.CHECK_HEALTH_REQUEST, async (): Promise<ExtensionResponse<CheckHealthResponseData>> => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch('http://127.0.0.1:8080/health', { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json().catch(() => ({ status: 'ok' }));
      return {
        success: true,
        data: {
          online: true,
          status: data.status || 'ok',
          model: 'qwen2.5-vl-3b',
          host: '127.0.0.1',
          port: 8080
        }
      };
    }
    return {
      success: true,
      data: {
        online: false,
        status: `HTTP ${res.status}`
      }
    };
  } catch (err) {
    return {
      success: true,
      data: {
        online: false,
        status: err instanceof Error ? err.message : 'Offline'
      }
    };
  }
});

/**
 * Handle direct AI chat requests with the local LLM.
 */
router.register<ChatRequest>(MessageType.CHAT_REQUEST, async (
  payload: ChatRequest,
  _sender: chrome.runtime.MessageSender
): Promise<ExtensionResponse<ChatResponseData>> => {
  try {
    const userMessage = (payload?.message ?? '').trim();
    if (!userMessage) {
      return {
        success: false,
        error: 'Message cannot be empty'
      };
    }

    // 1. Resolve target tab and metadata
    let tabId = payload?.tabId;
    let windowId = payload?.windowId;
    let tabUrl: string | undefined;
    let tabTitle: string | undefined;

    if (tabId === undefined) {
      const activeTab = await getActiveTab();
      tabId = activeTab?.id;
      windowId = activeTab?.windowId;
      tabUrl = activeTab?.url;
      tabTitle = activeTab?.title;
    } else {
      try {
        if (typeof chrome !== 'undefined' && chrome?.tabs?.get) {
          const tab = await chrome.tabs.get(tabId);
          tabUrl = tab?.url;
          tabTitle = tab?.title;
        }
      } catch {
        // Tab query fallback
      }
    }

    // 2. Extract and sanitize webpage context
    let pageContextText: string | undefined;

    if (tabUrl && isRestrictedUrl(tabUrl)) {
      pageContextText = buildRestrictedPageContext(tabUrl, tabTitle);
    } else if (typeof tabId === 'number' && !isNaN(tabId)) {
      try {
        const domProvider = createDomProvider(tabId);
        let rawPage: import('../shared/types.js').PageRepresentation;
        try {
          rawPage = await domProvider();
        } catch (firstErr) {
          // If content script was not ready or attached, attempt programmatic injection
          if (typeof chrome !== 'undefined' && (chrome as any)?.scripting?.executeScript) {
            try {
              await (chrome as any).scripting.executeScript({
                target: { tabId },
                files: ['content/content-script.js']
              });
              await new Promise(r => setTimeout(r, 100));
              rawPage = await domProvider();
            } catch {
              throw firstErr;
            }
          } else {
            throw firstErr;
          }
        }

        if (rawPage) {
          // Privacy boundary: sanitize all textual content before LLM exposure
          const sanitized = sanitizePageRepresentation(rawPage);
          pageContextText = buildPageChatContext(sanitized.pageRepresentation);
          if (!tabTitle && sanitized.pageRepresentation.metadata?.title) {
            tabTitle = sanitized.pageRepresentation.metadata.title;
          }
          if (!tabUrl && sanitized.pageRepresentation.metadata?.url) {
            tabUrl = sanitized.pageRepresentation.metadata.url;
          }
        }
      } catch (domErr) {
        const errMsg = domErr instanceof Error ? domErr.message : String(domErr);
        pageContextText = buildUnavailablePageContext(tabUrl, tabTitle, errMsg);
      }
    }

    // 3. Build grounded prompt
    const userPrompt = buildChatUserPrompt(userMessage, payload?.history, pageContextText);

    // 4. Query local model
    const client = new DefaultLocalLlamaChatClient();
    const response = await client.chat({
      systemPrompt: CHAT_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 512,
      temperature: 0.3
    });

    if (response.success) {
      return {
        success: true,
        data: {
          reply: response.content.trim(),
          model: 'qwen2.5-vl-3b',
          pageTitle: tabTitle,
          pageUrl: tabUrl
        }
      };
    } else {
      return {
        success: false,
        error: response.error.message || 'Local AI inference failed'
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to communicate with local AI server'
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
      if (!message || typeof message !== 'object' || !router.hasHandler(message.type)) {
        return false;
      }
      return dispatchMessageToRouter(router, message, sender, sendResponse);
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
