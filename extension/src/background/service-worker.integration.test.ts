/**
 * Phase 2D — Integration tests for the unified perception runtime.
 *
 * Strategy:
 * - Import createDomProvider and DOM_IPC_TIMEOUT_MS from service-worker.ts
 *   as exported helper functions (no Chrome API calls at module load time).
 * - Construct MessageRouter instances in-process (mirroring screenshot.test.ts pattern).
 * - Mock globalThis.chrome.tabs.sendMessage / captureVisibleTab at the boundary.
 * - Use vi.useFakeTimers() for timeout tests.
 *
 * These tests do NOT require a real browser. All Chrome APIs are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDomProvider, DOM_IPC_TIMEOUT_MS } from './service-worker.js';
import { perceivePage } from './orchestrator.js';
import { captureVisibleTab } from './screenshot.js';
import { MessageRouter } from '../shared/messaging.js';
import { MessageType } from '../shared/types.js';
import type {
  DomPerceptionProvider,
  ScreenshotProvider,
  VisualPerceptionAdapter,
  VisualObservation,
  UnifiedPerceptionResult
} from './orchestrator.js';
import type {
  PageRepresentation,
  ExtensionResponse,
  ScreenshotCaptureResult,
  UnifiedPerceptionRequest
} from '../shared/types.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_DOM: PageRepresentation = {
  schemaVersion: '1.0',
  metadata: { title: 'Integration Test Page', url: 'https://example.com' },
  viewport: { width: 1280, height: 720 },
  elements: [
    {
      id: 'elem-1',
      tagName: 'button',
      role: 'button',
      visibleText: 'Click me',
      interactive: true,
      provenance: 'dom'
    }
  ]
};

const MOCK_SCREENSHOT: ScreenshotCaptureResult = {
  dataUrl: 'data:image/png;base64,INTEGRATION_TEST_BYTES',
  format: 'png',
  timestamp: 1_700_000_000_000
};

const NULL_VISION_ADAPTER: VisualPerceptionAdapter = {
  name: 'NullVisionAdapter',
  async perceive(_input) {
    return { success: true, observations: [] as VisualObservation[] };
  }
};

const FAILING_VISION_ADAPTER: VisualPerceptionAdapter = {
  name: 'FailingVisionAdapter',
  async perceive(_input) {
    return {
      success: false,
      error: { code: 'PERCEPTION_FAILURE', message: 'Vision model unavailable' }
    };
  }
};

// ---------------------------------------------------------------------------
// Test 1 — createDomProvider sends correct message and returns PageRepresentation
// ---------------------------------------------------------------------------

describe('Phase 2D — createDomProvider', () => {
  const originalChrome = globalThis.chrome;

  afterEach(() => {
    globalThis.chrome = originalChrome;
    vi.restoreAllMocks();
  });

  it('1. should send INSPECT_PAGE_REQUEST to the given tabId and resolve PageRepresentation', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({
      success: true,
      data: MOCK_DOM,
      id: 'test-msg-1'
    });

    globalThis.chrome = {
      tabs: {
        sendMessage: sendMessageMock
      }
    } as any;

    const provider = createDomProvider(42);
    const dom = await provider();

    // Verify sendMessage was called with the tab ID
    expect(sendMessageMock).toHaveBeenCalledOnce();
    const callArgs = sendMessageMock.mock.calls[0]!;
    expect(callArgs[0]).toBe(42);
    expect(callArgs[1].type).toBe(MessageType.INSPECT_PAGE_REQUEST);

    // Verify the returned PageRepresentation matches
    expect(dom.schemaVersion).toBe('1.0');
    expect(dom.metadata.url).toBe('https://example.com');
    expect(dom.elements).toHaveLength(1);
    expect(dom.elements[0]!.id).toBe('elem-1');
  });

  // ---------------------------------------------------------------------------
  // Test 2 — Content script failure => domain error with origin 'dom'
  // ---------------------------------------------------------------------------

  it('2. should throw so perceivePage maps content-script failure to origin dom', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({
      success: false,
      error: 'Content script extraction failed'
    });

    globalThis.chrome = {
      tabs: {
        sendMessage: sendMessageMock
      }
    } as any;

    const provider = createDomProvider(99);

    // createDomProvider throws; perceivePage maps it to { origin: 'dom' }
    const result = await perceivePage(
      provider,
      async () => ({ format: 'png', timestamp: 0 }),  // screenshot provider (unused)
      NULL_VISION_ADAPTER
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.origin).toBe('dom');
    expect(result.error.message).toContain('Content script extraction failed');
  });

  // ---------------------------------------------------------------------------
  // Test 3 — DOM IPC timeout => origin 'dom'
  // ---------------------------------------------------------------------------

  it('3. should time out after DOM_IPC_TIMEOUT_MS and perceivePage maps it to origin dom', async () => {
    vi.useFakeTimers();

    // sendMessage never resolves (simulates missing content script)
    const sendMessageMock = vi.fn().mockImplementation(() => new Promise(() => {}));

    globalThis.chrome = {
      tabs: {
        sendMessage: sendMessageMock
      }
    } as any;

    const provider = createDomProvider(77);

    const resultPromise = perceivePage(
      provider,
      async () => ({ format: 'png', timestamp: 0 }),
      NULL_VISION_ADAPTER
    );

    // Advance timers past the timeout
    vi.advanceTimersByTime(DOM_IPC_TIMEOUT_MS + 100);

    const result = await resultPromise;

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.origin).toBe('dom');
    expect(result.error.message).toContain('timed out');

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Phase 2D pipeline tests (full perceivePage integration via mocked providers)
// ---------------------------------------------------------------------------

describe('Phase 2D — perceivePage pipeline integration', () => {
  const originalChrome = globalThis.chrome;

  afterEach(() => {
    globalThis.chrome = originalChrome;
    vi.restoreAllMocks();
  });

  // Test 4 — Screenshot failure => origin 'screenshot'
  it('4. should return origin screenshot when captureVisibleTab fails', async () => {
    const domProvider: DomPerceptionProvider = () => Promise.resolve(MOCK_DOM);

    const screenshotProvider: ScreenshotProvider = async () => {
      throw new Error('captureVisibleTab: restricted page');
    };

    const result = await perceivePage(domProvider, screenshotProvider, NULL_VISION_ADAPTER);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.origin).toBe('screenshot');
    expect(result.error.message).toContain('captureVisibleTab: restricted page');
  });

  // Test 5 — Vision failure => origin 'vision'
  it('5. should return origin vision when the vision adapter returns failure', async () => {
    const domProvider: DomPerceptionProvider = () => Promise.resolve(MOCK_DOM);
    const screenshotProvider: ScreenshotProvider = async () => ({
      format: 'png',
      timestamp: 123,
      dataUrl: 'data:image/png;base64,FAKE'
    });

    const result = await perceivePage(domProvider, screenshotProvider, FAILING_VISION_ADAPTER);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected failure');
    expect(result.error.origin).toBe('vision');
    expect(result.error.message).toBe('Vision model unavailable');
    expect(result.error.code).toBe('PERCEPTION_FAILURE');
  });

  // Test 6 — Successful pipeline returns DOM + screenshot metadata + empty observations
  it('6. should return successful unified result with DOM, screenshot metadata, and zero observations', async () => {
    const domProvider: DomPerceptionProvider = () => Promise.resolve(MOCK_DOM);
    const screenshotProvider: ScreenshotProvider = async () => ({
      format: 'png',
      timestamp: MOCK_SCREENSHOT.timestamp,
      dataUrl: MOCK_SCREENSHOT.dataUrl
    });

    const result = await perceivePage(domProvider, screenshotProvider, NULL_VISION_ADAPTER);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    // DOM representation intact
    expect(result.domRepresentation.metadata.url).toBe('https://example.com');
    expect(result.domRepresentation.elements).toHaveLength(1);

    // Screenshot reference: format and timestamp present, no dataUrl
    expect(result.screenshotRef.format).toBe('png');
    expect(result.screenshotRef.timestamp).toBe(MOCK_SCREENSHOT.timestamp);
    expect(result.screenshotRef).not.toHaveProperty('dataUrl');

    // Vision observations: null adapter returns empty array
    expect(result.visualObservations).toEqual([]);

    // Metadata
    expect(result.metadata.visionAdapterName).toBe('NullVisionAdapter');
    expect(result.metadata.orchestratedAt).toBeTypeOf('number');
    expect(result.metadata.orchestratedAt).toBeGreaterThan(0);
  });

  // Test 7 — dataUrl absent from final unified result
  it('7. should not forward screenshot dataUrl in the final unified result', async () => {
    const SENSITIVE_DATA_URL = 'data:image/png;base64,THIS_MUST_NOT_LEAK';

    const domProvider: DomPerceptionProvider = () => Promise.resolve(MOCK_DOM);
    const screenshotProvider: ScreenshotProvider = async () => ({
      format: 'png',
      timestamp: 1234,
      dataUrl: SENSITIVE_DATA_URL
    });

    const result = await perceivePage(domProvider, screenshotProvider, NULL_VISION_ADAPTER);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    // dataUrl must not be on screenshotRef in the result
    expect(result.screenshotRef).not.toHaveProperty('dataUrl');

    // dataUrl must not appear anywhere in the serialized result
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('THIS_MUST_NOT_LEAK');
    expect(Object.keys(result)).not.toContain('dataUrl');
  });

  // Test 8 — Sensitive form / password / cookie / storage data absent
  it('8. should not expose form values, passwords, cookies, or storage in unified result', async () => {
    const domProvider: DomPerceptionProvider = () => Promise.resolve(MOCK_DOM);
    const screenshotProvider: ScreenshotProvider = async () => ({
      format: 'png',
      timestamp: 0
    });

    const result = await perceivePage(domProvider, screenshotProvider, NULL_VISION_ADAPTER);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');

    const serialized = JSON.stringify(result);

    // Sensitive key names must not appear
    expect(serialized).not.toContain('"password"');
    expect(serialized).not.toContain('"cookie"');
    expect(serialized).not.toContain('"localStorage"');
    expect(serialized).not.toContain('"sessionStorage"');
    expect(serialized).not.toContain('"credentials"');

    // DOM elements must not contain raw input values
    for (const el of result.domRepresentation.elements) {
      expect(el).not.toHaveProperty('value');
    }
  });

  // Test 9 — UNIFIED_PERCEPTION_REQUEST routes through MessageRouter
  it('9. should route UNIFIED_PERCEPTION_REQUEST through MessageRouter and return UnifiedPerceptionResult', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({
      success: true,
      data: MOCK_DOM
    });
    const captureMock = vi.fn().mockResolvedValue('data:image/png;base64,MOCK_UNIFIED_BYTES');
    const queryMock = vi.fn().mockResolvedValue([
      { id: 42, windowId: 789, active: true }
    ]);

    globalThis.chrome = {
      tabs: {
        query: queryMock,
        sendMessage: sendMessageMock,
        captureVisibleTab: captureMock
      }
    } as any;

    // Construct a local router with the handler matching service-worker.ts implementation.
    // This validates routing plumbing without importing the module-level service-worker.ts.
    const router = new MessageRouter();

    const getActiveTabLocal = async (): Promise<chrome.tabs.Tab | undefined> => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs[0];
    };

    router.register(MessageType.UNIFIED_PERCEPTION_REQUEST, async (
      _payload: UnifiedPerceptionRequest | undefined,
      _sender: chrome.runtime.MessageSender
    ): Promise<ExtensionResponse<UnifiedPerceptionResult>> => {
      try {
        const activeTab = await getActiveTabLocal();
        if (!activeTab?.id) {
          return { success: false, error: 'No active tab found' };
        }

        const domProvider = createDomProvider(activeTab.id);

        const screenshotProvider: ScreenshotProvider = async () => {
          const dataUrl = await captureVisibleTab(activeTab.windowId);
          return {
            format: 'png' as const,
            timestamp: Date.now(),
            dataUrl: dataUrl.dataUrl
          };
        };

        const nullAdapter: VisualPerceptionAdapter = {
          name: 'NullVisionAdapter',
          async perceive(_input) {
            return { success: true, observations: [] as VisualObservation[] };
          }
        };

        const result = await perceivePage(domProvider, screenshotProvider, nullAdapter);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unified perception failed'
        };
      }
    });

    const response = await router.route(
      {
        type: MessageType.UNIFIED_PERCEPTION_REQUEST,
        payload: {},
        id: 'test-unified-1'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(response.success).toBe(true);
    expect(response.data).toBeDefined();

    const unified = response.data as UnifiedPerceptionResult;
    if (!unified.success) throw new Error('Expected unified success');

    // DOM representation present
    expect(unified.domRepresentation.elements).toHaveLength(1);

    // Screenshot ref present but NO dataUrl
    expect(unified.screenshotRef).not.toHaveProperty('dataUrl');
    expect(unified.screenshotRef.format).toBe('png');

    // Zero visual observations (null adapter)
    expect(unified.visualObservations).toHaveLength(0);

    // Router called the tab correctly
    expect(queryMock).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(sendMessageMock).toHaveBeenCalledOnce();
    expect(sendMessageMock.mock.calls[0]![0]).toBe(42);
    expect(captureMock).toHaveBeenCalledWith(789, { format: 'png' });
  });
});
