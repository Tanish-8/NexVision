/**
 * Popup UI logic for SIH26171 / NexVision extension.
 * - "Run Agent" button: sends RUN_AGENT_STEP_REQUEST, displays structured step log.
 * - "Inspect Page" button: existing behaviour preserved.
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
  GetAgentStatusResponseData
} from '../shared/types.js';
import type { DemoRunResult, DemoStep } from '../background/demoRunner.js';

// ---------------------------------------------------------------------------
// DOM element handles
// ---------------------------------------------------------------------------

const pageTitleEl       = document.getElementById('page-title')        as HTMLElement;
const pageUrlEl         = document.getElementById('page-url')          as HTMLElement;
const headingCountEl    = document.getElementById('heading-count')      as HTMLElement;
const errorMessageEl    = document.getElementById('error-message')      as HTMLElement;
const successMessageEl  = document.getElementById('success-message')    as HTMLElement;
const inspectBtn        = document.getElementById('inspect-btn')        as HTMLButtonElement;

// Agent demo elements
const taskInput         = document.getElementById('task-input')         as HTMLTextAreaElement;
const runAgentBtn       = document.getElementById('run-agent-btn')      as HTMLButtonElement;
const agentStatusEl     = document.getElementById('agent-status')       as HTMLElement;
const stepLogEl         = document.getElementById('step-log')           as HTMLElement;

// Step detail spans
const detailPerception  = document.getElementById('detail-perception')  as HTMLElement;
const detailPrivacy     = document.getElementById('detail-privacy')     as HTMLElement;
const detailGrounding   = document.getElementById('detail-grounding')   as HTMLElement;
const detailPlanning    = document.getElementById('detail-planning')    as HTMLElement;
const detailExecution   = document.getElementById('detail-execution')   as HTMLElement;
const detailVerification= document.getElementById('detail-verification')as HTMLElement;

// Step row elements (for status class)
const logRows: Record<string, HTMLElement> = {
  perception:   document.getElementById('log-perception')   as HTMLElement,
  privacy:      document.getElementById('log-privacy')      as HTMLElement,
  grounding:    document.getElementById('log-grounding')    as HTMLElement,
  planning:     document.getElementById('log-planning')     as HTMLElement,
  execution:    document.getElementById('log-execution')    as HTMLElement,
  verification: document.getElementById('log-verification') as HTMLElement,
};

let activeRunId: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  pageTitleEl.textContent = snapshot.metadata.title || '—';
  pageUrlEl.textContent = formatUrl(snapshot.metadata.url || '');
  const headingCount = snapshot.elements.filter(el => el.role === 'heading').length;
  headingCountEl.textContent = String(headingCount);
  successMessageEl.textContent = `Inspected at ${new Date().toLocaleTimeString()}`;
  successMessageEl.classList.remove('hidden');
  errorMessageEl.classList.add('hidden');
}

function displayError(message: string): void {
  errorMessageEl.textContent = message;
  errorMessageEl.classList.remove('hidden');
  successMessageEl.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Agent step log helpers
// ---------------------------------------------------------------------------

type RowStatus = 'pending' | 'ok' | 'err';

function setRowStatus(key: string, status: RowStatus, detail: string): void {
  const row = logRows[key];
  if (!row) return;
  row.className = `step-row ${status}`;
  const detailEl = row.querySelector('.step-detail');
  if (detailEl) detailEl.textContent = detail;
}

function resetStepLog(): void {
  for (const key of Object.keys(logRows)) {
    setRowStatus(key, 'pending', '—');
  }
}

function setAgentStatus(text: string, kind: 'success' | 'error' | 'info'): void {
  agentStatusEl.textContent = text;
  agentStatusEl.className = `agent-status visible ${kind}`;
}

function renderSteps(steps: readonly DemoStep[]): void {
  // Aggregate across all steps for the log rows
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

// ---------------------------------------------------------------------------
// Event-Driven Agent Lifecycle
// ---------------------------------------------------------------------------

function handleProgress(event: AgentProgressEvent): void {
  if (activeRunId && event.runId !== activeRunId) return;

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
      if (event.status === 'completed') {
        setRowStatus('privacy', 'ok', event.message);
      } else {
        setRowStatus('privacy', 'err', event.message);
      }
      break;

    case 'grounding':
      if (event.status === 'completed') {
        setRowStatus('grounding', 'ok', event.message);
      } else {
        setRowStatus('grounding', 'err', event.message);
      }
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
      if (event.status === 'running') {
        setRowStatus('execution', 'pending', event.message);
      } else if (event.status === 'completed') {
        setRowStatus('execution', 'ok', event.message);
      } else {
        setRowStatus('execution', 'err', event.message);
      }
      break;

    case 'verification':
      if (event.status === 'completed') {
        setRowStatus('verification', 'ok', event.message);
      } else {
        setRowStatus('verification', 'err', event.message);
      }
      break;
  }
}

function handleCompleted(event: AgentCompletedEvent): void {
  if (activeRunId && event.runId !== activeRunId) return;

  activeRunId = null;
  renderSteps(event.result.steps);

  const statusText =
    event.result.status === 'COMPLETED' ? `✓ Completed in ${event.result.totalSteps} step(s)` :
    event.result.status === 'MAX_STEPS_REACHED' ? `Stopped after ${event.result.totalSteps} steps — ${event.result.message}` :
    event.result.status === 'PERCEPTION_FAILED' ? `Perception failed — is the extension loaded on a page?` :
    `Stopped: ${event.result.message}`;

  setAgentStatus(
    statusText,
    event.result.status === 'COMPLETED' ? 'success' :
    event.result.status === 'MAX_STEPS_REACHED' ? 'info' : 'error'
  );

  runAgentBtn.disabled = false;
  runAgentBtn.textContent = '▶ Run Agent';
}

function handleFailed(event: AgentFailedEvent): void {
  if (activeRunId && event.runId !== activeRunId) return;

  activeRunId = null;
  if (event.steps && event.steps.length > 0) {
    renderSteps(event.steps);
  }
  setAgentStatus(`Error: ${event.error}`, 'error');

  runAgentBtn.disabled = false;
  runAgentBtn.textContent = '▶ Run Agent';
}

// ---------------------------------------------------------------------------
// Run Agent handler
// ---------------------------------------------------------------------------

async function runAgent(): Promise<void> {
  const goalDescription = taskInput.value.trim() || 'Search for laptops under ₹50,000';

  runAgentBtn.disabled = true;
  runAgentBtn.textContent = '⏳ Running…';
  stepLogEl.classList.add('visible');
  resetStepLog();
  setAgentStatus('Starting agent…', 'info');

  try {
    let activeTab: chrome.tabs.Tab | undefined;
    if (typeof chrome !== 'undefined' && typeof chrome.tabs?.query === 'function') {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
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
          goalDescription,
          tabId: activeTab?.id,
          windowId: activeTab?.windowId,
        } satisfies StartAgentRequest
      );

    if (!response.success || !response.data) {
      setAgentStatus(`Error: ${response.error ?? 'Failed to start agent'}`, 'error');
      setRowStatus('perception', 'err', response.error ?? 'Failed');
      runAgentBtn.disabled = false;
      runAgentBtn.textContent = '▶ Run Agent';
      return;
    }

    activeRunId = response.data.runId;
    setAgentStatus('Agent running — please wait…', 'info');
  } catch (err) {
    setAgentStatus(
      `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      'error'
    );
    runAgentBtn.disabled = false;
    runAgentBtn.textContent = '▶ Run Agent';
  }
}

// ---------------------------------------------------------------------------
// Inspect Page handler (unchanged behaviour)
// ---------------------------------------------------------------------------

async function inspectPage(): Promise<void> {
  inspectBtn.disabled = true;
  inspectBtn.textContent = 'Inspecting…';

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
    inspectBtn.disabled = false;
    inspectBtn.textContent = 'Inspect Page';
  }
}

// ---------------------------------------------------------------------------
// Status Sync & Init
// ---------------------------------------------------------------------------

async function syncAgentStatus(): Promise<void> {
  try {
    const response = await sendToBackground<GetAgentStatusResponseData>(
      MessageType.GET_AGENT_STATUS_REQUEST,
      {}
    );
    if (response.success && response.data?.active) {
      activeRunId = response.data.runId ?? null;
      runAgentBtn.disabled = true;
      runAgentBtn.textContent = '⏳ Running…';
      stepLogEl.classList.add('visible');
      setAgentStatus('Agent running — please wait…', 'info');
      if (response.data.steps && response.data.steps.length > 0) {
        renderSteps(response.data.steps);
      }
    }
  } catch {
    // Background service might not be ready yet
  }
}

function init(): void {
  runAgentBtn.addEventListener('click', runAgent);
  inspectBtn.addEventListener('click', inspectPage);

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

  syncAgentStatus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}