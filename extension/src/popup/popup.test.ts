/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageType } from '../shared/types.js';

describe('Popup runAgent tab selection (Requirement C)', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.clearAllMocks();

    document.body.innerHTML = `
      <textarea id="task-input">Search for laptops under ₹50,000</textarea>
      <button id="run-agent-btn">Run Agent</button>
      <div id="step-log"></div>
      <div id="agent-status"></div>
      <div id="detail-perception"></div>
      <div id="detail-privacy"></div>
      <div id="detail-grounding"></div>
      <div id="detail-planning"></div>
      <div id="detail-execution"></div>
      <div id="detail-verification"></div>
      <div id="log-perception"><span class="step-detail"></span></div>
      <div id="log-privacy"><span class="step-detail"></span></div>
      <div id="log-grounding"><span class="step-detail"></span></div>
      <div id="log-planning"><span class="step-detail"></span></div>
      <div id="log-execution"><span class="step-detail"></span></div>
      <div id="log-verification"><span class="step-detail"></span></div>
      <div id="page-title"></div>
      <div id="page-url"></div>
      <div id="heading-count"></div>
      <div id="error-message"></div>
      <div id="success-message"></div>
      <button id="inspect-btn">Inspect</button>
    `;
  });

  afterEach(() => {
    globalThis.chrome = originalChrome;
    vi.restoreAllMocks();
  });

  it('queries active tab with currentWindow: true and forwards tabId and windowId in START_AGENT_REQUEST', async () => {
    const queryMock = vi.fn().mockResolvedValue([
      { id: 42, windowId: 100, active: true }
    ]);
    const sendMessageMock = vi.fn().mockResolvedValue({
      success: true,
      data: { runId: 'run-123', startedAt: Date.now() }
    });

    globalThis.chrome = {
      tabs: {
        query: queryMock
      },
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: {
          addListener: vi.fn()
        }
      }
    } as any;

    // Dynamically import popup module after DOM and chrome mocks are established
    await import('./popup.js');

    const runAgentBtn = document.getElementById('run-agent-btn') as HTMLButtonElement;
    expect(runAgentBtn).not.toBeNull();

    // Trigger Run Agent
    runAgentBtn.click();

    // Allow microtasks to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify chrome.tabs.query was called with currentWindow: true, NOT lastFocusedWindow
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith({
      active: true,
      currentWindow: true
    });

    // Verify START_AGENT_REQUEST message was sent with tabId and windowId
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.START_AGENT_REQUEST,
        payload: {
          goalDescription: 'Search for laptops under ₹50,000',
          tabId: 42,
          windowId: 100
        }
      })
    );
  });
});
