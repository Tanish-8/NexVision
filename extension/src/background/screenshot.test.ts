/**
 * Tests for local screenshot capture helper and service worker message handling.
 *
 * NOTE: Vitest with happy-dom does not perform real browser captures.
 * These tests mock the chrome.tabs API boundary to verify parameter translation,
 * error handling, rate-limit resilience, privacy isolation, and message routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureVisibleTab } from './screenshot.js';
import { MessageRouter } from '../shared/messaging.js';
import { MessageType } from '../shared/types.js';
import type { ExtensionResponse, ScreenshotCaptureResult, ScreenshotCaptureOptions } from '../shared/types.js';

describe('captureVisibleTab', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
  });

  it('should capture visible tab with default options (PNG)', async () => {
    const fakeDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const captureMock = vi.fn().mockResolvedValue(fakeDataUrl);

    globalThis.chrome = {
      tabs: {
        captureVisibleTab: captureMock
      }
    } as any;

    const result = await captureVisibleTab(123);

    expect(captureMock).toHaveBeenCalledWith(123, { format: 'png' });
    expect(result.dataUrl).toBe(fakeDataUrl);
    expect(result.format).toBe('png');
    expect(result.timestamp).toBeTypeOf('number');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('should capture without windowId when windowId is omitted', async () => {
    const fakeDataUrl = 'data:image/png;base64,mockPngBytes';
    const captureMock = vi.fn().mockResolvedValue(fakeDataUrl);

    globalThis.chrome = {
      tabs: {
        captureVisibleTab: captureMock
      }
    } as any;

    const result = await captureVisibleTab();

    expect(captureMock).toHaveBeenCalledWith({ format: 'png' });
    expect(result.dataUrl).toBe(fakeDataUrl);
    expect(result.format).toBe('png');
  });

  it('should support JPEG format and quality setting', async () => {
    const fakeDataUrl = 'data:image/jpeg;base64,mockJpegBytes';
    const captureMock = vi.fn().mockResolvedValue(fakeDataUrl);

    globalThis.chrome = {
      tabs: {
        captureVisibleTab: captureMock
      }
    } as any;

    const result = await captureVisibleTab(456, { format: 'jpeg', quality: 80 });

    expect(captureMock).toHaveBeenCalledWith(456, { format: 'jpeg', quality: 80 });
    expect(result.dataUrl).toBe(fakeDataUrl);
    expect(result.format).toBe('jpeg');
  });

  it('should clamp JPEG quality to between 0 and 100', async () => {
    const fakeDataUrl = 'data:image/jpeg;base64,mockJpegBytes';
    const captureMock = vi.fn().mockResolvedValue(fakeDataUrl);

    globalThis.chrome = {
      tabs: {
        captureVisibleTab: captureMock
      }
    } as any;

    await captureVisibleTab(456, { format: 'jpeg', quality: 150 });
    expect(captureMock).toHaveBeenCalledWith(456, { format: 'jpeg', quality: 100 });

    await captureVisibleTab(456, { format: 'jpeg', quality: -25 });
    expect(captureMock).toHaveBeenCalledWith(456, { format: 'jpeg', quality: 0 });
  });

  it('should handle API failure gracefully', async () => {
    const captureMock = vi.fn().mockRejectedValue(new Error('Internal tab capture failure'));

    globalThis.chrome = {
      tabs: {
        captureVisibleTab: captureMock
      }
    } as any;

    await expect(captureVisibleTab(123)).rejects.toThrow(
      'Screenshot capture failed: Internal tab capture failure'
    );
  });

  it('should handle Chromium rate-limit / quota errors gracefully', async () => {
    const rateLimitError = new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND exceeded');
    const captureMock = vi.fn().mockRejectedValue(rateLimitError);

    globalThis.chrome = {
      tabs: {
        captureVisibleTab: captureMock
      }
    } as any;

    await expect(captureVisibleTab(123)).rejects.toThrow(
      'Screenshot capture failed: MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND exceeded'
    );
  });

  it('should throw if captureVisibleTab returns empty data', async () => {
    const captureMock = vi.fn().mockResolvedValue('');

    globalThis.chrome = {
      tabs: {
        captureVisibleTab: captureMock
      }
    } as any;

    await expect(captureVisibleTab(123)).rejects.toThrow(
      'Screenshot capture failed: No image data returned'
    );
  });

  it('should throw if chrome.tabs.captureVisibleTab is unavailable', async () => {
    globalThis.chrome = {
      tabs: {}
    } as any;

    await expect(captureVisibleTab(123)).rejects.toThrow(
      'Screenshot capture failed: chrome.tabs.captureVisibleTab API is not available'
    );
  });

  it('should guarantee no DOM, form, password, or credential leakage in result', async () => {
    const fakeDataUrl = 'data:image/png;base64,mockData';
    const captureMock = vi.fn().mockResolvedValue(fakeDataUrl);

    globalThis.chrome = {
      tabs: {
        captureVisibleTab: captureMock
      }
    } as any;

    const result = await captureVisibleTab(123);

    const keys = Object.keys(result);
    expect(keys).toEqual(['dataUrl', 'format', 'timestamp']);
    expect(result).not.toHaveProperty('dom');
    expect(result).not.toHaveProperty('html');
    expect(result).not.toHaveProperty('form');
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('credentials');
    expect(result).not.toHaveProperty('elements');
  });
});

describe('Screenshot message handling through MessageRouter', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
  });

  it('should route CAPTURE_SCREENSHOT_REQUEST, query active tab, and return ExtensionResponse', async () => {
    const fakeDataUrl = 'data:image/png;base64,validBase64Png';
    const captureMock = vi.fn().mockResolvedValue(fakeDataUrl);
    const queryMock = vi.fn().mockResolvedValue([
      { id: 42, windowId: 789, active: true }
    ]);

    globalThis.chrome = {
      tabs: {
        query: queryMock,
        captureVisibleTab: captureMock
      }
    } as any;

    const router = new MessageRouter();

    // Register handler matching service-worker.ts implementation
    const getActiveTab = async (): Promise<chrome.tabs.Tab | undefined> => {
      let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tabs[0]) return tabs[0];
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) return tabs[0];
      if (typeof chrome.windows?.getLastFocused === 'function') {
        try {
          const normalWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
          if (normalWindow?.id) {
            tabs = await chrome.tabs.query({ active: true, windowId: normalWindow.id });
            if (tabs[0]) return tabs[0];
          }
        } catch {
          // Ignore
        }
      }
      tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
      if (tabs[0]) return tabs[0];
      tabs = await chrome.tabs.query({ active: true });
      return tabs[0];
    };

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

    const response = await router.route(
      {
        type: MessageType.CAPTURE_SCREENSHOT_REQUEST,
        payload: { format: 'png' },
        id: 'test-msg-1'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(queryMock).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(captureMock).toHaveBeenCalledWith(789, { format: 'png' });
    expect(response.success).toBe(true);
    expect(response.data).toBeDefined();
    expect(response.data?.dataUrl).toBe(fakeDataUrl);
    expect(response.data?.format).toBe('png');
  });

  it('should fall back to normal browser window query when lastFocusedWindow query returns no active tab', async () => {
    const fakeDataUrl = 'data:image/png;base64,fallbackPng';
    const captureMock = vi.fn().mockResolvedValue(fakeDataUrl);
    const queryMock = vi.fn()
      .mockResolvedValueOnce([]) // lastFocusedWindow: true -> []
      .mockResolvedValueOnce([]) // currentWindow: true -> []
      .mockResolvedValueOnce([{ id: 99, windowId: 456, active: true }]); // windowType: 'normal' -> [tab]

    globalThis.chrome = {
      tabs: {
        query: queryMock,
        captureVisibleTab: captureMock
      }
    } as any;

    const router = new MessageRouter();

    const getActiveTab = async (): Promise<chrome.tabs.Tab | undefined> => {
      let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tabs[0]) return tabs[0];
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) return tabs[0];
      if (typeof chrome.windows?.getLastFocused === 'function') {
        try {
          const normalWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
          if (normalWindow?.id) {
            tabs = await chrome.tabs.query({ active: true, windowId: normalWindow.id });
            if (tabs[0]) return tabs[0];
          }
        } catch {
          // Ignore
        }
      }
      tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
      if (tabs[0]) return tabs[0];
      tabs = await chrome.tabs.query({ active: true });
      return tabs[0];
    };

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

    const response = await router.route(
      {
        type: MessageType.CAPTURE_SCREENSHOT_REQUEST,
        payload: { format: 'png' },
        id: 'test-msg-fallback'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(queryMock).toHaveBeenNthCalledWith(1, { active: true, lastFocusedWindow: true });
    expect(queryMock).toHaveBeenNthCalledWith(2, { active: true, currentWindow: true });
    expect(queryMock).toHaveBeenNthCalledWith(3, { active: true, windowType: 'normal' });
    expect(captureMock).toHaveBeenCalledWith(456, { format: 'png' });
    expect(response.success).toBe(true);
    expect(response.data?.dataUrl).toBe(fakeDataUrl);
  });

  it('should return failure response if no active tab is found anywhere', async () => {
    const queryMock = vi.fn().mockResolvedValue([]);

    globalThis.chrome = {
      tabs: {
        query: queryMock
      }
    } as any;

    const router = new MessageRouter();

    const getActiveTab = async (): Promise<chrome.tabs.Tab | undefined> => {
      let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tabs[0]) return tabs[0];
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) return tabs[0];
      tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
      if (tabs[0]) return tabs[0];
      tabs = await chrome.tabs.query({ active: true });
      return tabs[0];
    };

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

    const response = await router.route(
      {
        type: MessageType.CAPTURE_SCREENSHOT_REQUEST,
        id: 'test-msg-2'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(response.success).toBe(false);
    expect(response.error).toBe('No active tab found');
  });

  it('should catch captureVisibleTab errors and return failure without throwing', async () => {
    const queryMock = vi.fn().mockResolvedValue([
      { id: 42, windowId: 789, active: true }
    ]);
    const captureMock = vi.fn().mockRejectedValue(new Error('Cannot access contents of the page'));

    globalThis.chrome = {
      tabs: {
        query: queryMock,
        captureVisibleTab: captureMock
      }
    } as any;

    const router = new MessageRouter();

    const getActiveTab = async (): Promise<chrome.tabs.Tab | undefined> => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs[0];
    };

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

    const response = await router.route(
      {
        type: MessageType.CAPTURE_SCREENSHOT_REQUEST,
        id: 'test-msg-3'
      },
      {} as chrome.runtime.MessageSender
    );

    expect(response.success).toBe(false);
    expect(response.error).toContain('Cannot access contents of the page');
  });
});

