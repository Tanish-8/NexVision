/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageType } from '../shared/types.js';

describe('Popup Unified Chat + Browser Task Interface', () => {
  const originalChrome = globalThis.chrome;

  beforeEach(() => {
    vi.clearAllMocks();

    document.body.innerHTML = `
      <div id="ai-status-pill" class="status-pill offline">
        <span class="status-dot"></span>
        <span id="ai-status-text">Checking…</span>
      </div>
      <button id="toggle-inspector-btn"></button>
      <div id="inspector-drawer"></div>

      <button id="mode-chat-btn" class="mode-btn active"></button>
      <button id="mode-task-btn" class="mode-btn"></button>
      <span id="mode-badge">💬 Chat Mode</span>

      <main id="conversation-area">
        <div id="welcome-card">
          <div id="welcome-desc"></div>
          <div id="welcome-tags"></div>
        </div>
        <div id="messages-list"></div>
        <div id="thinking-indicator" style="display: none;"></div>
      </main>

      <textarea id="chat-input"></textarea>
      <button id="send-btn"></button>

      <!-- Legacy / Test compatibility elements -->
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
    const sendMessageMock = vi.fn().mockImplementation(async (msg) => {
      if (msg.type === MessageType.CHECK_HEALTH_REQUEST) {
        return { success: true, data: { online: true, model: 'qwen2.5-vl-3b' } };
      }
      return {
        success: true,
        data: { runId: 'run-123', startedAt: Date.now() }
      };
    });

    globalThis.chrome = {
      tabs: { query: queryMock },
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: { addListener: vi.fn() }
      }
    } as any;

    const popup = await import('./popup.js');
    popup.init();

    const runAgentBtn = document.getElementById('run-agent-btn') as HTMLButtonElement;
    expect(runAgentBtn).not.toBeNull();

    runAgentBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(queryMock).toHaveBeenCalledWith({
      active: true,
      currentWindow: true
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.START_AGENT_REQUEST,
        payload: expect.objectContaining({
          goalDescription: 'Search for laptops under ₹50,000',
          tabId: 42,
          windowId: 100
        })
      })
    );
  });

  it('handles Chat Mode: dispatches CHAT_REQUEST and renders assistant reply', async () => {
    const sendMessageMock = vi.fn().mockImplementation(async (msg) => {
      if (msg.type === MessageType.CHAT_REQUEST) {
        return {
          success: true,
          data: { reply: 'NexVision is an on-device privacy-first AI browser assistant.' }
        };
      }
      if (msg.type === MessageType.CHECK_HEALTH_REQUEST) {
        return { success: true, data: { online: true } };
      }
      return { success: true };
    });

    globalThis.chrome = {
      tabs: { query: vi.fn().mockResolvedValue([]) },
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: { addListener: vi.fn() }
      }
    } as any;

    const popup = await import('./popup.js');
    popup.init();
    popup.setMode('chat');

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;

    chatInput.value = 'What is NexVision?';
    sendBtn.click();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.CHAT_REQUEST,
        payload: expect.objectContaining({
          message: 'What is NexVision?'
        })
      })
    );

    const messagesList = document.getElementById('messages-list') as HTMLElement;
    expect(messagesList.textContent).toContain('What is NexVision?');
    expect(messagesList.textContent).toContain('NexVision is an on-device privacy-first AI browser assistant.');
  });

  it('forwards active tab tabId and windowId in CHAT_REQUEST when available', async () => {
    const queryMock = vi.fn().mockResolvedValue([
      { id: 777, windowId: 888, active: true }
    ]);
    const sendMessageMock = vi.fn().mockImplementation(async (msg) => {
      if (msg.type === MessageType.CHAT_REQUEST) {
        return {
          success: true,
          data: { reply: 'Wikipedia is a free online encyclopedia.' }
        };
      }
      return { success: true, data: { online: true } };
    });

    globalThis.chrome = {
      tabs: { query: queryMock },
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: { addListener: vi.fn() }
      }
    } as any;

    const popup = await import('./popup.js');
    popup.init();
    popup.setMode('chat');

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;

    chatInput.value = 'What is this webpage about?';
    sendBtn.click();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(queryMock).toHaveBeenCalledWith({
      active: true,
      currentWindow: true
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.CHAT_REQUEST,
        payload: expect.objectContaining({
          message: 'What is this webpage about?',
          tabId: 777,
          windowId: 888
        })
      })
    );
  });

  it('handles Browser Task Mode from unified chat input: dispatches START_AGENT_REQUEST and creates task card', async () => {
    const queryMock = vi.fn().mockResolvedValue([
      { id: 101, windowId: 202, active: true }
    ]);
    const sendMessageMock = vi.fn().mockImplementation(async (msg) => {
      if (msg.type === MessageType.START_AGENT_REQUEST) {
        return {
          success: true,
          data: { runId: 'run-unified-99', startedAt: Date.now() }
        };
      }
      return { success: true, data: { online: true } };
    });

    globalThis.chrome = {
      tabs: { query: queryMock },
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: { addListener: vi.fn() }
      }
    } as any;

    const popup = await import('./popup.js');
    popup.init();
    popup.setMode('task');

    const modeBadge = document.getElementById('mode-badge') as HTMLElement;
    expect(modeBadge.textContent).toContain('Browser Task Mode');

    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
    const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;

    chatInput.value = 'Find my latest Amazon transaction.';
    sendBtn.click();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.START_AGENT_REQUEST,
        payload: expect.objectContaining({
          goalDescription: 'Find my latest Amazon transaction.',
          tabId: 101,
          windowId: 202
        })
      })
    );

    const messagesList = document.getElementById('messages-list') as HTMLElement;
    expect(messagesList.textContent).toContain('Find my latest Amazon transaction.');
    expect(messagesList.textContent).toContain('Task: "Find my latest Amazon transaction."');
  });

  it('updates Local AI status indicator when server is online vs offline', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({
      success: true,
      data: { online: true, model: 'qwen2.5-vl-3b' }
    });

    globalThis.chrome = {
      tabs: { query: vi.fn().mockResolvedValue([]) },
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: { addListener: vi.fn() }
      }
    } as any;

    const popup = await import('./popup.js');
    popup.init();
    await popup.checkLocalAiHealth();

    const pill = document.getElementById('ai-status-pill') as HTMLElement;
    const statusText = document.getElementById('ai-status-text') as HTMLElement;

    expect(pill.classList.contains('online')).toBe(true);
    expect(statusText.textContent).toBe('Local AI: Online');
  });

  it('displays clean universal welcome message and generic placeholder with zero demo buttons (Issue 3)', async () => {
    globalThis.chrome = {
      tabs: { query: vi.fn().mockResolvedValue([]) },
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ success: true, data: { online: true } }),
        onMessage: { addListener: vi.fn() }
      }
    } as any;

    const popup = await import('./popup.js');
    popup._resetStateForTesting();
    popup.init();
    popup.setMode('chat');

    const welcomeDesc = document.getElementById('welcome-desc') as HTMLElement;
    const welcomeTags = document.getElementById('welcome-tags') as HTMLElement;
    const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;

    expect(welcomeDesc.textContent).toContain(
      "Ask me questions or give me instructions to interact with the current webpage. I'll understand the page, protect sensitive information, and execute supported tasks locally."
    );
    expect(chatInput.placeholder).toBe('Ask anything or describe a browser task...');
    expect(welcomeTags.querySelectorAll('button').length).toBe(0);
    expect(document.body.textContent).not.toContain('Amazon transaction');
    expect(document.body.textContent).not.toContain('Swiggy order');
    expect(document.body.textContent).not.toContain('Netflix payment');
  });

  it('updates all 6 pipeline phases dynamically upon live progress events (Issue 1)', async () => {
    const runId = 'agent-run-test-live-progress';
    const sendMessageMock = vi.fn().mockImplementation(async (msg) => {
      if (msg.type === MessageType.START_AGENT_REQUEST) {
        return {
          success: true,
          data: { runId, startedAt: Date.now() }
        };
      }
      return { success: true, data: { online: true } };
    });

    globalThis.chrome = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1, windowId: 1, active: true }]) },
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: { addListener: vi.fn() }
      }
    } as any;

    const popup = await import('./popup.js');
    popup._resetStateForTesting();
    popup.init();
    popup.setMode('task');

    await popup.submitTask('Find my latest Amazon transaction.');

    const card = document.querySelector('.task-card') as HTMLElement;
    expect(card).not.toBeNull();

    // 1. Perception running -> completed
    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'perception',
      status: 'running',
      message: 'Perceiving page (DOM + Vision)…',
      timestamp: Date.now()
    });
    const stepPerception = card.querySelector('[data-phase="perception"]') as HTMLElement;
    expect(stepPerception.classList.contains('running')).toBe(true);
    expect(stepPerception.querySelector('.step-message')?.textContent).toBe('Perceiving page (DOM + Vision)…');

    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'perception',
      status: 'completed',
      message: '34 elements, 12 interactive',
      timestamp: Date.now()
    });
    expect(stepPerception.classList.contains('completed')).toBe(true);
    expect(stepPerception.querySelector('.step-indicator')?.textContent).toContain('✓');

    // 2. Privacy completed
    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'privacy',
      status: 'completed',
      message: 'No PII detected',
      timestamp: Date.now()
    });
    const stepPrivacy = card.querySelector('[data-phase="privacy"]') as HTMLElement;
    expect(stepPrivacy.classList.contains('completed')).toBe(true);
    expect(stepPrivacy.querySelector('.step-message')?.textContent).toBe('No PII detected');

    // 3. Grounding completed
    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'grounding',
      status: 'completed',
      message: '12 targets resolved',
      timestamp: Date.now()
    });
    const stepGrounding = card.querySelector('[data-phase="grounding"]') as HTMLElement;
    expect(stepGrounding.classList.contains('completed')).toBe(true);
    expect(stepGrounding.querySelector('.step-message')?.textContent).toBe('12 targets resolved');

    // 4. Planning running -> completed
    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'planning',
      status: 'running',
      message: 'Querying local model for next step…',
      timestamp: Date.now()
    });
    const stepPlanning = card.querySelector('[data-phase="planning"]') as HTMLElement;
    expect(stepPlanning.classList.contains('running')).toBe(true);

    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'planning',
      status: 'completed',
      message: 'type → Search for Amazon',
      timestamp: Date.now()
    });
    expect(stepPlanning.classList.contains('completed')).toBe(true);
    expect(stepPlanning.querySelector('.step-message')?.textContent).toBe('type → Search for Amazon');

    // 5. Execution running -> completed
    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'execution',
      status: 'running',
      message: 'Executing type…',
      timestamp: Date.now()
    });
    const stepExecution = card.querySelector('[data-phase="execution"]') as HTMLElement;
    expect(stepExecution.classList.contains('running')).toBe(true);

    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'execution',
      status: 'completed',
      message: 'type executed ✓',
      timestamp: Date.now()
    });
    expect(stepExecution.classList.contains('completed')).toBe(true);
    expect(stepExecution.querySelector('.step-message')?.textContent).toBe('type executed ✓');

    // 6. Verification running -> completed
    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'verification',
      status: 'running',
      message: 'Verifying search result…',
      timestamp: Date.now()
    });
    const stepVerification = card.querySelector('[data-phase="verification"]') as HTMLElement;
    expect(stepVerification.classList.contains('running')).toBe(true);

    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'verification',
      status: 'completed',
      message: '5 search results displayed',
      timestamp: Date.now()
    });
    expect(stepVerification.classList.contains('completed')).toBe(true);
    expect(stepVerification.querySelector('.step-message')?.textContent).toBe('5 search results displayed');
  });

  it('terminates task cleanly upon goal verification completion with duration and action count (Issue 2)', async () => {
    const runId = 'agent-run-test-completion';
    globalThis.chrome = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1, windowId: 1, active: true }]) },
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          success: true,
          data: { runId, startedAt: Date.now() }
        }),
        onMessage: { addListener: vi.fn() }
      }
    } as any;

    const popup = await import('./popup.js');
    popup._resetStateForTesting();
    popup.init();
    popup.setMode('task');

    await popup.submitTask('Find my latest Amazon transaction.');

    const card = document.querySelector('.task-card') as HTMLElement;
    const badge = card.querySelector('.task-badge') as HTMLElement;
    expect(badge.textContent).toBe('Running');
    expect(badge.classList.contains('running')).toBe(true);

    // Goal verifier confirms success
    popup.handleCompleted({
      runId,
      result: {
        status: 'COMPLETED',
        totalSteps: 2,
        message: 'Whole goal verified: latest Amazon transaction details opened and verified',
        steps: [
          {
            stepIndex: 0,
            perception: { elementCount: 30, interactiveCount: 10, visualObservationCount: 0, privacyFindingCount: 0, visionAdapterName: 'none' },
            plan: { status: 'ACTION', actionType: 'type' },
            execution: { success: true, actionType: 'type' },
            verification: { verified: true, message: 'typed' }
          },
          {
            stepIndex: 1,
            perception: { elementCount: 35, interactiveCount: 12, visualObservationCount: 0, privacyFindingCount: 0, visionAdapterName: 'none' },
            plan: { status: 'ACTION', actionType: 'click' },
            execution: { success: true, actionType: 'click' },
            verification: { verified: true, message: 'modal visible' }
          }
        ]
      },
      timestamp: Date.now() + 1500
    });

    // Verify badge updated to Completed
    expect(badge.textContent).toBe('Completed');
    expect(badge.classList.contains('completed')).toBe(true);

    // Verify all 6 phases marked completed
    const phases = ['perception', 'privacy', 'grounding', 'planning', 'execution', 'verification'];
    for (const p of phases) {
      const step = card.querySelector(`[data-phase="${p}"]`) as HTMLElement;
      expect(step.classList.contains('completed')).toBe(true);
      expect(step.querySelector('.step-indicator')?.textContent).toContain('✓');
    }

    // Verify duration and action count shown
    const resultMsg = card.querySelector('.task-result-message') as HTMLElement;
    expect(resultMsg).not.toBeNull();
    expect(resultMsg.textContent).toContain('2 actions');
    expect(resultMsg.textContent).toContain('Whole goal verified');

    // Verify actual final result displayed in conversation list
    const messagesList = document.getElementById('messages-list') as HTMLElement;
    expect(messagesList.textContent).toContain('Whole goal verified: latest Amazon transaction details opened and verified');

    // Verify input and send buttons re-enabled
    const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);

    // Verify duplicate terminal event is ignored
    const messageCountBefore = messagesList.children.length;
    popup.handleCompleted({
      runId,
      result: {
        status: 'COMPLETED',
        totalSteps: 2,
        message: 'Duplicate event',
        steps: []
      },
      timestamp: Date.now()
    });
    expect(messagesList.children.length).toBe(messageCountBefore);
  });

  it('handles task failure safely without falsely reporting success', async () => {
    const runId = 'agent-run-test-failure';
    globalThis.chrome = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1, windowId: 1, active: true }]) },
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          success: true,
          data: { runId, startedAt: Date.now() }
        }),
        onMessage: { addListener: vi.fn() }
      }
    } as any;

    const popup = await import('./popup.js');
    popup._resetStateForTesting();
    popup.init();
    popup.setMode('task');

    await popup.submitTask('Find non-existent transaction.');

    const card = document.querySelector('.task-card') as HTMLElement;
    const badge = card.querySelector('.task-badge') as HTMLElement;

    // Planning phase running
    popup.handleProgress({
      runId,
      stepIndex: 0,
      phase: 'planning',
      status: 'running',
      message: 'Querying model...',
      timestamp: Date.now()
    });

    // Agent fails
    popup.handleFailed({
      runId,
      error: 'No matching transaction found on page',
      timestamp: Date.now()
    });

    expect(badge.textContent).toBe('Failed');
    expect(badge.classList.contains('failed')).toBe(true);

    const stepPlanning = card.querySelector('[data-phase="planning"]') as HTMLElement;
    expect(stepPlanning.classList.contains('failed')).toBe(true);

    const messagesList = document.getElementById('messages-list') as HTMLElement;
    expect(messagesList.textContent).toContain('Execution error: No matching transaction found on page');

    const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
  });
});
