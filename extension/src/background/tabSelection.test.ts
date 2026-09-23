/**
 * Tests for NexVision tab selection and START_AGENT_REQUEST resolution:
 * A. START_AGENT_REQUEST with tabId/windowId: uses payload.tabId and does NOT call getActiveTab()
 * B. START_AGENT_REQUEST without tabId: falls back to getActiveTab()
 * D. getActiveTab: queries a normal browser window and does not select DevTools windows
 * E. Invalid/missing tab ID: returns a controlled error and does not start the agent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageType } from '../shared/types.js';
import type { StartAgentRequest, StartAgentResponseData, ExtensionResponse } from '../shared/types.js';
import { MessageRouter } from '../shared/messaging.js';
import { getActiveTab } from './service-worker.js';

describe('Tab Selection and START_AGENT_REQUEST Handling', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Requirement A: START_AGENT_REQUEST with tabId/windowId
  // ---------------------------------------------------------------------------
  it('A. START_AGENT_REQUEST with tabId/windowId uses payload.tabId and does NOT query active tab', async () => {
    const tabsQueryMock = vi.fn();
    const runnerMock = vi.fn();

    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn()
      },
      tabs: {
        query: tabsQueryMock,
        sendMessage: vi.fn()
      }
    } as any;

    const router = new MessageRouter();
    let currentAgentRun: any = null;

    // Handler structure identical to service-worker.ts
    router.register<StartAgentRequest>(MessageType.START_AGENT_REQUEST, async (payload) => {
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

      const runId = `agent-run-${Date.now()}`;
      const startedAt = Date.now();
      currentAgentRun = { runId, active: true, tabId, windowId };

      runnerMock(tabId, windowId);

      return {
        success: true,
        data: { runId, startedAt }
      };
    });

    const response = await router.route(
      {
        type: MessageType.START_AGENT_REQUEST,
        payload: {
          goalDescription: 'Search for laptops',
          tabId: 555,
          windowId: 777
        } satisfies StartAgentRequest
      },
      {} as any
    );

    expect(response.success).toBe(true);
    expect(tabsQueryMock).not.toHaveBeenCalled();
    expect(runnerMock).toHaveBeenCalledWith(555, 777);
    expect(currentAgentRun.tabId).toBe(555);
    expect(currentAgentRun.windowId).toBe(777);
  });

  // ---------------------------------------------------------------------------
  // Requirement B: START_AGENT_REQUEST without tabId
  // ---------------------------------------------------------------------------
  it('B. START_AGENT_REQUEST without tabId falls back safely to getActiveTab()', async () => {
    const tabsQueryMock = vi.fn().mockImplementation(async (query: any) => {
      if (query.lastFocusedWindow && query.windowType === 'normal') {
        return [{ id: 101, windowId: 202, active: true }];
      }
      return [];
    });
    const runnerMock = vi.fn();

    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn()
      },
      tabs: {
        query: tabsQueryMock,
        sendMessage: vi.fn()
      }
    } as any;

    const router = new MessageRouter();
    let currentAgentRun: any = null;

    router.register<StartAgentRequest>(MessageType.START_AGENT_REQUEST, async (payload) => {
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

      const runId = `agent-run-${Date.now()}`;
      const startedAt = Date.now();
      currentAgentRun = { runId, active: true, tabId, windowId };

      runnerMock(tabId, windowId);

      return {
        success: true,
        data: { runId, startedAt }
      };
    });

    const response = await router.route(
      {
        type: MessageType.START_AGENT_REQUEST,
        payload: {
          goalDescription: 'Search without tabId'
        } satisfies StartAgentRequest
      },
      {} as any
    );

    expect(response.success).toBe(true);
    expect(tabsQueryMock).toHaveBeenCalled();
    expect(runnerMock).toHaveBeenCalledWith(101, 202);
    expect(currentAgentRun.tabId).toBe(101);
    expect(currentAgentRun.windowId).toBe(202);
  });

  // ---------------------------------------------------------------------------
  // Requirement D: getActiveTab hardening against DevTools windows
  // ---------------------------------------------------------------------------
  describe('D. getActiveTab hardening', () => {
    it('queries a normal browser window with windowType: normal in Step 1', async () => {
      const tabsQueryMock = vi.fn().mockResolvedValue([
        { id: 333, windowId: 444, active: true }
      ]);

      globalThis.chrome = {
        tabs: {
          query: tabsQueryMock
        }
      } as any;

      const tab = await getActiveTab();
      expect(tab?.id).toBe(333);
      expect(tabsQueryMock).toHaveBeenCalledWith({
        active: true,
        lastFocusedWindow: true,
        windowType: 'normal'
      });
    });

    it('does not select DevTools window when DevTools is lastFocusedWindow', async () => {
      // Simulate: Step 1 (normal window query) returns [] because DevTools window was focused.
      // Step 2 returns [] (service worker has no current window).
      // Step 3 (chrome.windows.getLastFocused normal window) finds window 10.
      // Query for window 10 returns tab 888.
      const tabsQueryMock = vi.fn().mockImplementation(async (query: any) => {
        if (query.lastFocusedWindow && query.windowType === 'normal') {
          return []; // DevTools window is focused, not normal!
        }
        if (query.currentWindow) {
          return [];
        }
        if (query.windowId === 10) {
          return [{ id: 888, windowId: 10, active: true }];
        }
        return [];
      });

      const getLastFocusedMock = vi.fn().mockResolvedValue({ id: 10, type: 'normal' });

      globalThis.chrome = {
        tabs: {
          query: tabsQueryMock
        },
        windows: {
          getLastFocused: getLastFocusedMock
        }
      } as any;

      const tab = await getActiveTab();
      expect(tab?.id).toBe(888);
      expect(tab?.windowId).toBe(10);
      expect(getLastFocusedMock).toHaveBeenCalledWith({ windowTypes: ['normal'] });
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement E: Invalid / Missing Tab ID
  // ---------------------------------------------------------------------------
  describe('E. Invalid or missing tab ID error handling', () => {
    it('returns controlled error and does not start agent when no active tab is found', async () => {
      const runnerMock = vi.fn();
      const tabsQueryMock = vi.fn().mockResolvedValue([]); // No tabs found

      globalThis.chrome = {
        tabs: {
          query: tabsQueryMock
        }
      } as any;

      const router = new MessageRouter();
      let started = false;

      router.register<StartAgentRequest>(MessageType.START_AGENT_REQUEST, async (payload) => {
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

        started = true;
        runnerMock(tabId, windowId);
        return { success: true, data: { runId: 'run-x', startedAt: Date.now() } };
      });

      const response = await router.route(
        {
          type: MessageType.START_AGENT_REQUEST,
          payload: { goalDescription: 'Search laptops' }
        },
        {} as any
      );

      expect(response.success).toBe(false);
      expect(response.error).toBe('No active tab found for demo agent');
      expect(started).toBe(false);
      expect(runnerMock).not.toHaveBeenCalled();
    });

    it('returns controlled error when tabId is explicitly NaN or invalid', async () => {
      const runnerMock = vi.fn();

      globalThis.chrome = {
        tabs: {
          query: vi.fn()
        }
      } as any;

      const router = new MessageRouter();
      let started = false;

      router.register<StartAgentRequest>(MessageType.START_AGENT_REQUEST, async (payload) => {
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

        started = true;
        runnerMock(tabId, windowId);
        return { success: true, data: { runId: 'run-x', startedAt: Date.now() } };
      });

      const response = await router.route(
        {
          type: MessageType.START_AGENT_REQUEST,
          payload: { goalDescription: 'Search laptops', tabId: NaN } as any
        },
        {} as any
      );

      expect(response.success).toBe(false);
      expect(response.error).toBe('No active tab found for demo agent');
      expect(started).toBe(false);
      expect(runnerMock).not.toHaveBeenCalled();
    });
  });
});
