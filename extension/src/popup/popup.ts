/**
 * Popup UI logic for SIH26171 / NexVision extension.
 * Unified AI Chat + Browser Task Interface with real local inference.
 */

import { MessageType } from '../shared/types.js';
import { sendToBackground } from '../shared/messaging.js';
import type {
  PageRepresentation,
  ExtensionResponse,
  ExtensionMessage,
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
import type { DemoStep } from '../background/demoRunner.js';

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

export type PopupMode = 'chat' | 'task';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  mode: PopupMode;
  text: string;
  timestamp: number;
  isError?: boolean;
  researchContext?: import('../shared/types.js').ChatResearchContext;
  taskData?: {
    runId: string;
    goal: string;
    status: 'running' | 'completed' | 'failed';
    phases: Record<string, { status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'; message: string }>;
    resultText?: string;
    startedAt?: number;
    durationMs?: number;
    actionCount?: number;
  };
}

// ---------------------------------------------------------------------------
// Dynamic DOM Elements Accessor (Prevents stale node caching in test & live DOM)
// ---------------------------------------------------------------------------

export function getDomElements() {
  return {
    aiStatusPill:     document.getElementById('ai-status-pill') as HTMLElement | null,
    aiStatusText:     document.getElementById('ai-status-text') as HTMLElement | null,
    toggleInspector:  document.getElementById('toggle-inspector-btn') as HTMLButtonElement | null,
    inspectorDrawer:  document.getElementById('inspector-drawer') as HTMLElement | null,

    modeChatBtn:      document.getElementById('mode-chat-btn') as HTMLButtonElement | null,
    modeTaskBtn:      document.getElementById('mode-task-btn') as HTMLButtonElement | null,
    modeBadge:        document.getElementById('mode-badge') as HTMLElement | null,

    conversationArea: document.getElementById('conversation-area') as HTMLElement | null,
    messagesList:     document.getElementById('messages-list') as HTMLElement | null,
    welcomeCard:      document.getElementById('welcome-card') as HTMLElement | null,
    welcomeDesc:      document.getElementById('welcome-desc') as HTMLElement | null,
    welcomeTags:      document.getElementById('welcome-tags') as HTMLElement | null,
    thinkingIndicator:document.getElementById('thinking-indicator') as HTMLElement | null,
    chatInput:        document.getElementById('chat-input') as HTMLTextAreaElement | null,
    sendBtn:          document.getElementById('send-btn') as HTMLButtonElement | null,

    taskInput:        document.getElementById('task-input') as HTMLTextAreaElement | null,
    runAgentBtn:      document.getElementById('run-agent-btn') as HTMLButtonElement | null,
    agentStatusEl:    document.getElementById('agent-status') as HTMLElement | null,
    stepLogEl:        document.getElementById('step-log') as HTMLElement | null,

    pageTitleEl:      document.getElementById('page-title') as HTMLElement | null,
    pageUrlEl:        document.getElementById('page-url') as HTMLElement | null,
    headingCountEl:   document.getElementById('heading-count') as HTMLElement | null,
    errorMessageEl:   document.getElementById('error-message') as HTMLElement | null,
    successMessageEl: document.getElementById('success-message') as HTMLElement | null,
    inspectBtn:       document.getElementById('inspect-btn') as HTMLButtonElement | null,

    logRows: {
      perception:   document.getElementById('log-perception'),
      privacy:      document.getElementById('log-privacy'),
      grounding:    document.getElementById('log-grounding'),
      planning:     document.getElementById('log-planning'),
      execution:    document.getElementById('log-execution'),
      verification: document.getElementById('log-verification')
    } as Record<string, HTMLElement | null>
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentMode: PopupMode = 'chat';
let activeRunId: string | null = null;
const sessionMessages: ChatMessage[] = [];
const processedTerminalRuns = new Set<string>();

export function _resetStateForTesting(): void {
  activeRunId = null;
  sessionMessages.length = 0;
  processedTerminalRuns.clear();
}

// ---------------------------------------------------------------------------
// Mode Switching
// ---------------------------------------------------------------------------

export function setMode(mode: PopupMode): void {
  currentMode = mode;
  const els = getDomElements();

  if (mode === 'chat') {
    if (els.modeChatBtn) {
      els.modeChatBtn.classList.add('active');
      els.modeChatBtn.setAttribute('aria-selected', 'true');
    }
    if (els.modeTaskBtn) {
      els.modeTaskBtn.classList.remove('active');
      els.modeTaskBtn.setAttribute('aria-selected', 'false');
    }
    if (els.modeBadge) {
      els.modeBadge.textContent = '💬 Chat Mode';
    }
    if (els.chatInput) {
      els.chatInput.placeholder = 'Ask anything or describe a browser task...';
    }
    if (els.welcomeDesc) {
      els.welcomeDesc.textContent =
        "Ask me questions or give me instructions to interact with the current webpage. I'll understand the page, protect sensitive information, and execute supported tasks locally.";
    }
    if (els.welcomeTags) {
      els.welcomeTags.innerHTML = '';
      els.welcomeTags.style.display = 'none';
    }
  } else {
    if (els.modeTaskBtn) {
      els.modeTaskBtn.classList.add('active');
      els.modeTaskBtn.setAttribute('aria-selected', 'true');
    }
    if (els.modeChatBtn) {
      els.modeChatBtn.classList.remove('active');
      els.modeChatBtn.setAttribute('aria-selected', 'false');
    }
    if (els.modeBadge) {
      els.modeBadge.textContent = '🌐 Browser Task Mode';
    }
    if (els.chatInput) {
      els.chatInput.placeholder = 'Ask anything or describe a browser task...';
    }
    if (els.welcomeDesc) {
      els.welcomeDesc.textContent =
        "Ask me questions or give me instructions to interact with the current webpage. I'll understand the page, protect sensitive information, and execute supported tasks locally.";
    }
    if (els.welcomeTags) {
      els.welcomeTags.innerHTML = '';
      els.welcomeTags.style.display = 'none';
    }
  }
}

function attachSampleTagListeners(): void {
  // Demo suggestion buttons removed per user specification
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

export async function checkLocalAiHealth(): Promise<void> {
  const els = getDomElements();
  if (!els.aiStatusPill || !els.aiStatusText) return;

  try {
    const res: ExtensionResponse<CheckHealthResponseData> =
      await sendToBackground<CheckHealthResponseData>(MessageType.CHECK_HEALTH_REQUEST, {});

    if (res.success && res.data?.online) {
      els.aiStatusPill.className = 'status-pill online';
      els.aiStatusPill.title = `Model: ${res.data.model ?? 'qwen2.5-vl-3b'} on ${res.data.host ?? '127.0.0.1'}:${res.data.port ?? 8080}`;
      els.aiStatusText.textContent = 'Local AI: Online';
    } else {
      els.aiStatusPill.className = 'status-pill offline';
      els.aiStatusPill.title = 'Local llama-server is unreachable on 127.0.0.1:8080';
      els.aiStatusText.textContent = 'Local AI: Offline';
    }
  } catch {
    els.aiStatusPill.className = 'status-pill offline';
    els.aiStatusText.textContent = 'Local AI: Offline';
  }
}

// ---------------------------------------------------------------------------
// Rendering Messages
// ---------------------------------------------------------------------------

function scrollToBottom(): void {
  const els = getDomElements();
  if (els.conversationArea) {
    els.conversationArea.scrollTop = els.conversationArea.scrollHeight;
  }
}

function renderMessage(msg: ChatMessage): void {
  const els = getDomElements();
  if (!els.messagesList) return;

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${msg.sender}`;
  wrapper.id = `msg-${msg.id}`;

  const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (msg.sender === 'user') {
    wrapper.innerHTML = `
      <div class="bubble">${escapeHtml(msg.text)}</div>
      <div class="message-meta">${timeStr} · ${msg.mode === 'task' ? '🌐 Task' : '💬 Chat'}</div>
    `;
  } else {
    if (msg.taskData) {
      wrapper.innerHTML = renderTaskCardHtml(msg.taskData, timeStr);
    } else {
      const errorClass = msg.isError ? ' error' : '';
      const researchMeta = msg.researchContext?.searchedQuery
        ? ` · Researched "${escapeHtml(msg.researchContext.searchedQuery)}"`
        : '';
      wrapper.innerHTML = `
        <div class="bubble${errorClass}">${formatAssistantText(msg.text)}</div>
        <div class="message-meta">NexVision AI · ${timeStr}${researchMeta}</div>
      `;
    }
  }

  els.messagesList.appendChild(wrapper);
  scrollToBottom();
}

function renderTaskCardHtml(taskData: NonNullable<ChatMessage['taskData']>, timeStr: string): string {
  const badgeClass =
    taskData.status === 'completed' ? 'completed' :
    taskData.status === 'failed' ? 'failed' : 'running';
  const badgeText =
    taskData.status === 'completed' ? 'Completed' :
    taskData.status === 'failed' ? 'Failed' : 'Running';

  const phases = ['perception', 'privacy', 'grounding', 'planning', 'execution', 'verification'] as const;
  const stepLabels: Record<string, string> = {
    perception: 'DOM Perception',
    privacy: 'Privacy Sanitization',
    grounding: 'Element Grounding',
    planning: 'Task Planning',
    execution: 'Validated Execution',
    verification: 'Postcondition Verification'
  };

  const stepsHtml = phases.map(phase => {
    const data = taskData.phases[phase] || { status: 'pending', message: '—' };
    const indicatorHtml =
      data.status === 'completed' ? '✓' :
      data.status === 'failed' ? '✕' :
      data.status === 'skipped' ? '↷' :
      data.status === 'running' ? '<span class="step-spinner" aria-label="Running"></span>' : '○';

    return `
      <div class="pipeline-step ${data.status}" id="card-step-${phase}" data-phase="${phase}">
        <div class="step-left">
          <span class="step-indicator">${indicatorHtml}</span>
          <span>${stepLabels[phase]}</span>
        </div>
        <span class="step-message" title="${escapeHtml(data.message)}">${escapeHtml(data.message)}</span>
      </div>
    `;
  }).join('');

  const resultMessageHtml = taskData.resultText
    ? `<div class="task-result-message">${escapeHtml(taskData.resultText)}</div>`
    : '';

  return `
    <div class="task-card" id="task-card-${taskData.runId}" data-run-id="${taskData.runId}">
      <div class="task-card-header">
        <div class="task-card-title">
          <span>🌐</span> Task: "${escapeHtml(taskData.goal)}"
        </div>
        <span class="task-badge ${badgeClass}" id="card-badge-${taskData.runId}">${badgeText}</span>
      </div>
      <div class="task-pipeline">
        ${stepsHtml}
      </div>
      ${resultMessageHtml}
    </div>
    <div class="message-meta">NexVision Agent · ${timeStr}</div>
  `;
}

function updateTaskCardInDom(taskData: NonNullable<ChatMessage['taskData']>): void {
  // Resilient element lookup: by ID, data attribute, or latest task card
  let card = document.getElementById(`task-card-${taskData.runId}`);
  if (!card) {
    card = document.querySelector(`.task-card[data-run-id="${taskData.runId}"]`);
  }
  if (!card) {
    const allCards = document.querySelectorAll('.task-card');
    if (allCards.length > 0) {
      card = allCards[allCards.length - 1] as HTMLElement;
    }
  }
  if (!card) return;

  // Keep IDs and data attributes synchronized
  card.id = `task-card-${taskData.runId}`;
  card.setAttribute('data-run-id', taskData.runId);

  const badge = card.querySelector('.task-badge') as HTMLElement | null;
  if (badge) {
    badge.className = `task-badge ${taskData.status}`;
    badge.textContent =
      taskData.status === 'completed' ? 'Completed' :
      taskData.status === 'failed' ? 'Failed' : 'Running';
  }

  const phases = ['perception', 'privacy', 'grounding', 'planning', 'execution', 'verification'] as const;
  for (const phase of phases) {
    const stepEl = (card.querySelector(`[data-phase="${phase}"]`) || card.querySelector(`#card-step-${phase}`)) as HTMLElement | null;
    const data = taskData.phases[phase];
    if (stepEl && data) {
      stepEl.className = `pipeline-step ${data.status}`;
      stepEl.setAttribute('data-phase', phase);
      const indicator = stepEl.querySelector('.step-indicator');
      if (indicator) {
        indicator.innerHTML =
          data.status === 'completed' ? '✓' :
          data.status === 'failed' ? '✕' :
          data.status === 'skipped' ? '↷' :
          data.status === 'running' ? '<span class="step-spinner" aria-label="Running"></span>' : '○';
      }
      const msg = stepEl.querySelector('.step-message');
      if (msg) {
        msg.textContent = data.message;
        msg.setAttribute('title', data.message);
      }
    }
  }

  if (taskData.resultText) {
    let resultEl = card.querySelector('.task-result-message') as HTMLElement | null;
    if (!resultEl) {
      resultEl = document.createElement('div');
      resultEl.className = 'task-result-message';
      card.appendChild(resultEl);
    }
    resultEl.textContent = taskData.resultText;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatAssistantText(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br/>');
}

// ---------------------------------------------------------------------------
// Chat Submission Handler
// ---------------------------------------------------------------------------

export async function submitChatMessage(text: string): Promise<void> {
  const userText = text.trim();
  if (!userText) return;

  const els = getDomElements();

  const userMsg: ChatMessage = {
    id: `user-${Date.now()}`,
    sender: 'user',
    mode: 'chat',
    text: userText,
    timestamp: Date.now()
  };
  sessionMessages.push(userMsg);
  renderMessage(userMsg);

  if (els.chatInput) els.chatInput.value = '';

  let tabId: number | undefined;
  let windowId: number | undefined;
  let initialThinking = 'Thinking';

  if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        tabId = activeTab.id;
        windowId = activeTab.windowId;
        if (activeTab.url) {
          try {
            const host = new URL(activeTab.url).hostname.replace(/^www\./, '');
            const isDiscovery = /\b(?:best|laptop|phone|buy|search|price|under|cheap|cost|item|product)\b/i.test(userText);
            if (host && isDiscovery) {
              initialThinking = `Searching ${host}...`;
            } else if (host) {
              initialThinking = `Analyzing ${host}...`;
            }
          } catch {
            // URL parse fallback
          }
        }
      }
    } catch {
      // Fallback tab query will be executed in service-worker
    }
  }

  setThinking(true, initialThinking);

  const history = sessionMessages
    .filter(m => m.mode === 'chat' && !m.isError)
    .slice(-6)
    .map(m => ({
      role: m.sender,
      content: m.text
    }));

  try {
    const res: ExtensionResponse<ChatResponseData> =
      await sendToBackground<ChatResponseData>(MessageType.CHAT_REQUEST, {
        message: userText,
        history,
        tabId,
        windowId
      } satisfies ChatRequest);

    setThinking(false);

    if (res.success && res.data?.reply) {
      const assistantMsg: ChatMessage = {
        id: `asst-${Date.now()}`,
        sender: 'assistant',
        mode: 'chat',
        text: res.data.reply,
        timestamp: Date.now(),
        researchContext: res.data.researchContext
      };
      sessionMessages.push(assistantMsg);
      renderMessage(assistantMsg);
    } else {
      const errorMsg: ChatMessage = {
        id: `asst-err-${Date.now()}`,
        sender: 'assistant',
        mode: 'chat',
        text: `⚠️ Local Model Error: ${res.error || 'Failed to generate response. Is llama-server running on 127.0.0.1:8080?'}`,
        timestamp: Date.now(),
        isError: true
      };
      sessionMessages.push(errorMsg);
      renderMessage(errorMsg);
    }
  } catch (err) {
    setThinking(false);
    const errorMsg: ChatMessage = {
      id: `asst-err-${Date.now()}`,
      sender: 'assistant',
      mode: 'chat',
      text: `⚠️ Connection Error: ${err instanceof Error ? err.message : 'Failed to reach background service'}`,
      timestamp: Date.now(),
      isError: true
    };
    sessionMessages.push(errorMsg);
    renderMessage(errorMsg);
  }
}

function setThinking(active: boolean, statusText?: string): void {
  const els = getDomElements();
  if (els.thinkingIndicator) {
    els.thinkingIndicator.style.display = active ? 'flex' : 'none';
    const textSpan = els.thinkingIndicator.querySelector('span');
    if (textSpan) {
      textSpan.textContent = active ? (statusText || 'Thinking') : 'Thinking';
    }
  }
  if (els.sendBtn) els.sendBtn.disabled = active;
  if (els.chatInput) els.chatInput.disabled = active;
  if (active) scrollToBottom();
  else if (els.chatInput) els.chatInput.focus();
}

// ---------------------------------------------------------------------------
// Browser Task Submission Handler
// ---------------------------------------------------------------------------

export async function submitTask(goalDescription: string): Promise<void> {
  const goal = goalDescription.trim() || 'Search for laptops under ₹50,000';
  const els = getDomElements();

  if (els.taskInput) els.taskInput.value = goal;

  const userMsg: ChatMessage = {
    id: `user-${Date.now()}`,
    sender: 'user',
    mode: 'task',
    text: goal,
    timestamp: Date.now()
  };
  sessionMessages.push(userMsg);
  renderMessage(userMsg);

  if (els.chatInput) els.chatInput.value = '';

  const runId = `agent-run-${Date.now()}`;
  activeRunId = runId;

  const taskMsg: ChatMessage = {
    id: `task-${Date.now()}`,
    sender: 'assistant',
    mode: 'task',
    text: '',
    timestamp: Date.now(),
    taskData: {
      runId,
      goal,
      status: 'running',
      startedAt: Date.now(),
      phases: {
        perception: { status: 'running', message: 'Analyzing webpage structure…' },
        privacy: { status: 'pending', message: 'Checking sensitive information…' },
        grounding: { status: 'pending', message: 'Identifying the target element…' },
        planning: { status: 'pending', message: 'Preparing browser actions…' },
        execution: { status: 'pending', message: 'Executing validated action…' },
        verification: { status: 'pending', message: 'Verifying the final result…' }
      }
    }
  };
  sessionMessages.push(taskMsg);
  renderMessage(taskMsg);

  if (els.sendBtn) els.sendBtn.disabled = true;
  if (els.runAgentBtn) {
    els.runAgentBtn.disabled = true;
    els.runAgentBtn.textContent = '⏳ Running…';
  }
  if (els.stepLogEl) els.stepLogEl.classList.add('visible');
  resetStepLog();
  setAgentStatus('Starting agent…', 'info');

  try {
    let activeTab: chrome.tabs.Tab | undefined;
    if (typeof chrome !== 'undefined' && typeof chrome.tabs?.query === 'function') {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        activeTab = tab;
      } catch {
        // Fallback handled safely by service worker
      }
    }

    const response: ExtensionResponse<StartAgentResponseData> =
      await sendToBackground<StartAgentResponseData>(
        MessageType.START_AGENT_REQUEST,
        {
          goalDescription: goal,
          tabId: activeTab?.id,
          windowId: activeTab?.windowId,
          runId
        } satisfies StartAgentRequest
      );

    if (!response.success || !response.data) {
      const err = response.error ?? 'Failed to start agent';
      if (taskMsg.taskData) {
        taskMsg.taskData.status = 'failed';
        taskMsg.taskData.resultText = `Failed to start: ${err}`;
        updateTaskCardInDom(taskMsg.taskData);
      }
      setAgentStatus(`Error: ${err}`, 'error');
      setRowStatus('perception', 'err', err);
      if (els.sendBtn) els.sendBtn.disabled = false;
      if (els.runAgentBtn) {
        els.runAgentBtn.disabled = false;
        els.runAgentBtn.textContent = '▶ Run Agent';
      }
      return;
    }

    if (response.data.runId && response.data.runId !== runId) {
      const oldRunId = runId;
      activeRunId = response.data.runId;
      if (taskMsg.taskData) {
        taskMsg.taskData.runId = activeRunId;
      }
      const card = document.getElementById(`task-card-${oldRunId}`);
      if (card) {
        card.id = `task-card-${activeRunId}`;
        card.setAttribute('data-run-id', activeRunId);
      }
    }
    setAgentStatus('Agent running — please wait…', 'info');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    if (taskMsg.taskData) {
      taskMsg.taskData.status = 'failed';
      taskMsg.taskData.resultText = `Error: ${errorMsg}`;
      updateTaskCardInDom(taskMsg.taskData);
    }
    setAgentStatus(`Error: ${errorMsg}`, 'error');
    if (els.sendBtn) els.sendBtn.disabled = false;
    if (els.runAgentBtn) {
      els.runAgentBtn.disabled = false;
      els.runAgentBtn.textContent = '▶ Run Agent';
    }
  }
}

// ---------------------------------------------------------------------------
// Send Button Dispatcher
// ---------------------------------------------------------------------------

export function handleSend(): void {
  const els = getDomElements();
  if (!els.chatInput) return;
  const text = els.chatInput.value.trim();
  if (!text) return;

  if (currentMode === 'chat') {
    submitChatMessage(text);
  } else {
    submitTask(text);
  }
}

// ---------------------------------------------------------------------------
// Legacy Step Log & Agent Event Handlers (Preserved for compatibility)
// ---------------------------------------------------------------------------

type RowStatus = 'pending' | 'ok' | 'err';

function setRowStatus(key: string, status: RowStatus, detail: string): void {
  const els = getDomElements();
  const row = els.logRows[key];
  if (!row) return;
  row.className = `step-row ${status}`;
  const detailEl = row.querySelector('.step-detail');
  if (detailEl) detailEl.textContent = detail;
}

function resetStepLog(): void {
  const els = getDomElements();
  for (const key of Object.keys(els.logRows)) {
    setRowStatus(key, 'pending', '—');
  }
}

function setAgentStatus(text: string, kind: 'success' | 'error' | 'info'): void {
  const els = getDomElements();
  if (!els.agentStatusEl) return;
  els.agentStatusEl.textContent = text;
  els.agentStatusEl.className = `agent-status visible ${kind}`;
}

function renderSteps(steps: readonly DemoStep[]): void {
  let totalElements = 0;
  let totalInteractive = 0;
  let totalVisualObs = 0;
  let totalPrivacyFindings = 0;
  let lastPlanStatus = '';
  let lastRationale = '';
  let lastActionType = '';
  let lastExecSuccess: boolean | undefined;
  let lastExecReason = '';

  for (const step of steps) {
    const p = step.perception;
    totalElements = Math.max(totalElements, p.elementCount);
    totalInteractive = Math.max(totalInteractive, p.interactiveCount);
    totalVisualObs += p.visualObservationCount;
    totalPrivacyFindings += p.privacyFindingCount;
    lastPlanStatus = step.plan.status;
    lastRationale = step.plan.rationale ?? '';
    lastActionType = step.plan.actionType ?? '';
    if (step.execution !== undefined) {
      lastExecSuccess = step.execution.success;
      lastExecReason = step.execution.reason ?? '';
    }
  }

  const visionNote = totalVisualObs > 0
    ? `${totalVisualObs} visual obs`
    : `DOM-only (no llama-server)`;

  setRowStatus(
    'perception', 'ok',
    `${totalElements} elements, ${totalInteractive} interactive · ${visionNote}`
  );

  setRowStatus(
    'privacy', totalPrivacyFindings > 0 ? 'ok' : 'ok',
    totalPrivacyFindings > 0
      ? `${totalPrivacyFindings} finding(s) redacted ✓`
      : 'No PII detected'
  );

  setRowStatus(
    'grounding', 'ok',
    totalInteractive > 0 ? `${totalInteractive} targets resolved` : 'No targets'
  );

  setRowStatus(
    'planning',
    lastPlanStatus === 'ACTION' ? 'ok' :
    lastPlanStatus === 'COMPLETED' ? 'ok' : 'err',
    lastPlanStatus === 'ACTION'
      ? `${lastActionType} → ${lastRationale}`
      : lastPlanStatus === 'COMPLETED'
      ? `Completed — ${lastRationale}`
      : `Failed — ${lastRationale}`
  );

  if (lastExecSuccess !== undefined) {
    setRowStatus(
      'execution',
      lastExecSuccess ? 'ok' : 'err',
      lastExecSuccess
        ? `${lastActionType} executed ✓`
        : `Failed: ${lastExecReason}`
    );
    setRowStatus(
      'verification',
      lastExecSuccess ? 'ok' : 'err',
      lastExecSuccess
        ? `Page interaction confirmed (step ${steps.length})`
        : 'Not reached'
    );
  } else {
    setRowStatus('execution', 'pending', 'Not executed');
    setRowStatus('verification', 'pending', 'Not reached');
  }
}

export function handleProgress(event: AgentProgressEvent): void {
  const targetRunId = event.runId || activeRunId;
  if (activeRunId && event.runId && activeRunId !== event.runId) {
    const matchingMsg = sessionMessages.find(m => m.taskData && m.taskData.runId === activeRunId);
    if (matchingMsg && matchingMsg.taskData) {
      matchingMsg.taskData.runId = event.runId;
      activeRunId = event.runId;
    }
  } else if (!activeRunId && event.runId) {
    activeRunId = event.runId;
  }

  // Update legacy step-log if elements exist
  switch (event.phase) {
    case 'perception':
      if (event.status === 'running') {
        setRowStatus('perception', 'pending', event.message);
      } else if (event.status === 'completed') {
        const obs = (event.data?.visualObservationCount ?? 0) > 0
          ? `${event.data?.visualObservationCount} visual obs`
          : 'DOM-only (no llama-server)';
        setRowStatus(
          'perception',
          'ok',
          `${event.data?.elementCount ?? 0} elements, ${event.data?.interactiveCount ?? 0} interactive · ${obs}`
        );
      } else {
        setRowStatus('perception', 'err', event.message);
      }
      break;

    case 'privacy':
      setRowStatus('privacy', event.status === 'completed' ? 'ok' : 'err', event.message);
      break;

    case 'grounding':
      setRowStatus('grounding', event.status === 'completed' ? 'ok' : 'err', event.message);
      break;

    case 'planning':
      if (event.status === 'running') {
        setRowStatus('planning', 'pending', event.message);
      } else if (event.status === 'completed') {
        setRowStatus('planning', 'ok', event.message);
      } else {
        setRowStatus('planning', 'err', event.message);
      }
      break;

    case 'execution':
      setRowStatus('execution', event.status === 'completed' ? 'ok' : (event.status === 'running' ? 'pending' : 'err'), event.message);
      break;

    case 'verification':
      setRowStatus('verification', event.status === 'completed' ? 'ok' : 'err', event.message);
      break;
  }

  const activeMsg = sessionMessages.find(
    m => m.taskData && (m.taskData.runId === (event.runId || activeRunId) || (activeRunId && m.taskData.runId === activeRunId))
  );
  if (!activeMsg || !activeMsg.taskData) return;

  if (activeMsg.taskData.runId !== event.runId && event.runId) {
    activeMsg.taskData.runId = event.runId;
    activeRunId = event.runId;
  }

  // If a subsequent step (>0) starts perception, reset downstream steps for that step
  if (event.stepIndex > 0 && event.phase === 'perception' && event.status === 'running') {
    activeMsg.taskData.phases.planning = { status: 'pending', message: 'Preparing next action…' };
    activeMsg.taskData.phases.execution = { status: 'pending', message: 'Pending next action…' };
    activeMsg.taskData.phases.verification = { status: 'pending', message: 'Awaiting next verification…' };
  }

  const stepPrefix = (event.stepIndex > 0) ? `[Step ${event.stepIndex + 1}] ` : '';
  const displayMsg = `${stepPrefix}${event.message}`;

  activeMsg.taskData.phases[event.phase] = {
    status: event.status === 'completed' ? 'completed' : (event.status === 'failed' ? 'failed' : 'running'),
    message: displayMsg
  };

  updateTaskCardInDom(activeMsg.taskData);
}

export function handleCompleted(event: AgentCompletedEvent): void {
  if (processedTerminalRuns.has(event.runId)) return;
  processedTerminalRuns.add(event.runId);

  const els = getDomElements();
  if (activeRunId === event.runId) {
    activeRunId = null;
  }

  if (event.result.steps && event.result.steps.length > 0) {
    renderSteps(event.result.steps);
  }

  const isCompleted = event.result.status === 'COMPLETED';

  const activeMsg = sessionMessages.find(
    m => m.taskData && (m.taskData.runId === event.runId || (activeRunId && m.taskData.runId === activeRunId))
  );

  const actionCount = event.result.steps
    ? event.result.steps.filter(s => s.execution?.success).length
    : (event.result.totalSteps ?? 0);

  const startedAt = activeMsg?.taskData?.startedAt;
  const durationMs = startedAt ? (event.timestamp - startedAt) : undefined;
  const durationStr = durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : '';
  const actionStr = `${actionCount} action${actionCount === 1 ? '' : 's'}`;
  const metaParts = [durationStr, actionStr].filter(Boolean).join(' · ');
  const metaText = metaParts ? ` (${metaParts})` : '';

  let statusText = '';
  if (isCompleted) {
    statusText = `✓ Completed${metaText} — ${event.result.message}`;
  } else if (event.result.status === 'MAX_STEPS_REACHED') {
    statusText = `Stopped after ${event.result.totalSteps} steps${metaText} — ${event.result.message}`;
  } else if (event.result.status === 'PERCEPTION_FAILED') {
    statusText = `Perception failed — ${event.result.message}`;
  } else {
    statusText = `Stopped (${event.result.status})${metaText} — ${event.result.message}`;
  }

  setAgentStatus(
    statusText,
    isCompleted ? 'success' : (event.result.status === 'MAX_STEPS_REACHED' ? 'info' : 'error')
  );

  if (activeMsg && activeMsg.taskData) {
    activeMsg.taskData.status = isCompleted ? 'completed' : 'failed';
    activeMsg.taskData.resultText = statusText;
    activeMsg.taskData.actionCount = actionCount;
    activeMsg.taskData.durationMs = durationMs;

    if (isCompleted) {
      const phases = ['perception', 'privacy', 'grounding', 'planning', 'execution', 'verification'] as const;
      for (const p of phases) {
        const current = activeMsg.taskData.phases[p];
        if (!current || (current.status !== 'failed' && current.status !== 'skipped')) {
          activeMsg.taskData.phases[p] = {
            status: 'completed',
            message: current?.message || 'Completed ✓'
          };
        }
      }
    }

    updateTaskCardInDom(activeMsg.taskData);
  }

  // Display actual final result in conversation
  const resultChatMsg: ChatMessage = {
    id: `result-${Date.now()}`,
    sender: 'assistant',
    mode: 'task',
    isError: !isCompleted,
    text: statusText,
    timestamp: Date.now()
  };
  sessionMessages.push(resultChatMsg);
  renderMessage(resultChatMsg);

  if (els.sendBtn) els.sendBtn.disabled = false;
  if (els.runAgentBtn) {
    els.runAgentBtn.disabled = false;
    els.runAgentBtn.textContent = '▶ Run Agent';
  }
}

export function handleFailed(event: AgentFailedEvent): void {
  if (processedTerminalRuns.has(event.runId)) return;
  processedTerminalRuns.add(event.runId);

  const els = getDomElements();
  if (activeRunId === event.runId) {
    activeRunId = null;
  }

  if (event.steps && event.steps.length > 0) {
    renderSteps(event.steps);
  }

  const errorText = `✕ Execution error: ${event.error}`;
  setAgentStatus(errorText, 'error');

  const activeMsg = sessionMessages.find(
    m => m.taskData && (m.taskData.runId === event.runId || (activeRunId && m.taskData.runId === activeRunId))
  );

  if (activeMsg && activeMsg.taskData) {
    activeMsg.taskData.status = 'failed';
    activeMsg.taskData.resultText = errorText;

    const phases = ['perception', 'privacy', 'grounding', 'planning', 'execution', 'verification'] as const;
    for (const p of phases) {
      if (activeMsg.taskData.phases[p]?.status === 'running') {
        activeMsg.taskData.phases[p] = {
          status: 'failed',
          message: event.error
        };
      }
    }

    updateTaskCardInDom(activeMsg.taskData);
  }

  const errorChatMsg: ChatMessage = {
    id: `error-${Date.now()}`,
    sender: 'assistant',
    mode: 'task',
    isError: true,
    text: errorText,
    timestamp: Date.now()
  };
  sessionMessages.push(errorChatMsg);
  renderMessage(errorChatMsg);

  if (els.sendBtn) els.sendBtn.disabled = false;
  if (els.runAgentBtn) {
    els.runAgentBtn.disabled = false;
    els.runAgentBtn.textContent = '▶ Run Agent';
  }
}

// ---------------------------------------------------------------------------
// Legacy Run Agent & Inspector Handlers (Preserved for compatibility)
// ---------------------------------------------------------------------------

async function runAgent(): Promise<void> {
  const els = getDomElements();
  const goal = els.taskInput?.value.trim() || 'Search for laptops under ₹50,000';
  await submitTask(goal);
}

function formatUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return path.length > 40 ? path.substring(0, 37) + '...' : path || u.hostname;
  } catch {
    return url;
  }
}

function displaySnapshot(snapshot: PageRepresentation): void {
  const els = getDomElements();
  if (els.pageTitleEl) els.pageTitleEl.textContent = snapshot.metadata.title || '—';
  if (els.pageUrlEl) els.pageUrlEl.textContent = formatUrl(snapshot.metadata.url || '');
  const headingCount = snapshot.elements.filter(el => el.role === 'heading').length;
  if (els.headingCountEl) els.headingCountEl.textContent = String(headingCount);
  if (els.successMessageEl) {
    els.successMessageEl.textContent = `Inspected at ${new Date().toLocaleTimeString()}`;
    els.successMessageEl.classList.remove('hidden');
  }
  if (els.errorMessageEl) els.errorMessageEl.classList.add('hidden');
}

function displayError(message: string): void {
  const els = getDomElements();
  if (els.errorMessageEl) {
    els.errorMessageEl.textContent = message;
    els.errorMessageEl.classList.remove('hidden');
  }
  if (els.successMessageEl) els.successMessageEl.classList.add('hidden');
}

async function inspectPage(): Promise<void> {
  const els = getDomElements();
  if (els.inspectBtn) {
    els.inspectBtn.disabled = true;
    els.inspectBtn.textContent = 'Inspecting…';
  }

  try {
    const response: ExtensionResponse<PageRepresentation> =
      await sendToBackground<PageRepresentation>(MessageType.INSPECT_PAGE_REQUEST, {});

    if (response.success && response.data) {
      displaySnapshot(response.data);
    } else {
      displayError(response.error || 'Inspection failed');
    }
  } catch {
    displayError('Failed to communicate with background service');
  } finally {
    if (els.inspectBtn) {
      els.inspectBtn.disabled = false;
      els.inspectBtn.textContent = 'Inspect Active Page';
    }
  }
}

async function syncAgentStatus(): Promise<void> {
  try {
    const response = await sendToBackground<GetAgentStatusResponseData>(
      MessageType.GET_AGENT_STATUS_REQUEST,
      {}
    );
    if (response.success && response.data?.active) {
      const els = getDomElements();
      activeRunId = response.data.runId ?? null;
      if (els.runAgentBtn) {
        els.runAgentBtn.disabled = true;
        els.runAgentBtn.textContent = '⏳ Running…';
      }
      if (els.stepLogEl) els.stepLogEl.classList.add('visible');
      setAgentStatus('Agent running — please wait…', 'info');
      if (response.data.steps && response.data.steps.length > 0) {
        renderSteps(response.data.steps);
      }
    }
  } catch {
    // Background service might not be ready yet
  }
}

// ---------------------------------------------------------------------------
// Init & Event Listeners
// ---------------------------------------------------------------------------

export function init(): void {
  const els = getDomElements();

  els.modeChatBtn?.addEventListener('click', () => setMode('chat'));
  els.modeTaskBtn?.addEventListener('click', () => setMode('task'));

  els.sendBtn?.addEventListener('click', handleSend);
  els.chatInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  els.toggleInspector?.addEventListener('click', () => {
    if (els.inspectorDrawer) {
      els.inspectorDrawer.classList.toggle('visible');
    }
  });

  els.runAgentBtn?.addEventListener('click', runAgent);
  els.inspectBtn?.addEventListener('click', inspectPage);

  attachSampleTagListeners();

  if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === MessageType.AGENT_PROGRESS_EVENT && message.payload) {
        handleProgress(message.payload as AgentProgressEvent);
      } else if (message.type === MessageType.AGENT_COMPLETED_EVENT && message.payload) {
        handleCompleted(message.payload as AgentCompletedEvent);
      } else if (message.type === MessageType.AGENT_FAILED_EVENT && message.payload) {
        handleFailed(message.payload as AgentFailedEvent);
      }
    });
  }

  checkLocalAiHealth();
  syncAgentStatus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}