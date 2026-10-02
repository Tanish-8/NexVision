import fs from 'fs';
import path from 'path';
import { DeterministicRulePlanner, resolveActivePhase, isMediaContentGoal, isProfileOrChannelCandidate, isMediaContentCandidate, isMediaContentUrl, isProfileOrChannelUrl } from '../dist/shared/planner.js';
import { decomposeTaskGoal, scoreCandidateRelevance, getPhaseRolePriority } from '../dist/background/localAgent.js';
import { verifyWholeGoalOutcome, verifyPhaseMilestone } from '../dist/background/demoRunner.js';

// Read bundled content script
const contentScriptPath = 'c:/Users/madis/OneDrive/Desktop/SIH/extension/dist/content/content-script.js';
let contentScriptCode = fs.readFileSync(contentScriptPath, 'utf-8');

// Expose extract and execute on window
contentScriptCode = contentScriptCode.replace(
  /\}\)\(\);?\s*$/,
  `  window.__nexvision_extract = extractPageRepresentationFromDom;
  window.__nexvision_execute = executeDomAction;
})();`
);

async function getOrOpenYouTubeTab() {
  const resp = await fetch('http://127.0.0.1:9222/json/list');
  const tabs = await resp.json();
  let ytTab = tabs.find(t => t.type === 'page' && t.url && t.url.includes('youtube.com'));
  if (ytTab) {
    return { wsUrl: ytTab.webSocketDebuggerUrl, tabId: ytTab.id, url: ytTab.url };
  }
  const newTab = tabs.find(t => t.type === 'page' && t.url && t.url.includes('newtab'));
  if (newTab) {
    return { wsUrl: newTab.webSocketDebuggerUrl, tabId: newTab.id, url: newTab.url };
  }
  const createResp = await fetch('http://127.0.0.1:9222/json/new?https://www.youtube.com/');
  const created = await createResp.json();
  return { wsUrl: created.webSocketDebuggerUrl, tabId: created.id, url: created.url };
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.idCounter = 1;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
    });
  }

  async send(method, params = {}) {
    const id = this.idCounter++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 4000));
  }

  close() {
    this.ws.close();
  }
}

async function runLiveE2E() {
  console.log('==================================================');
  console.log('LIVE E2E: YouTube Search and Play Verification');
  console.log('Goal: "Search for MrBeast and play the first video"');
  console.log('==================================================');

  console.log('\n[1] Connecting to Chrome via CDP...');
  const { wsUrl, tabId, url } = await getOrOpenYouTubeTab();
  console.log(`Connected to tab ${tabId} (${url})`);

  const cdp = new CDPClient(wsUrl);
  await cdp.connect();
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  });

  console.log('\n[2] Navigating to https://www.youtube.com/ to ensure clean start...');
  await cdp.navigate('https://www.youtube.com/');
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n[3] Injecting NexVision perception and execution engine...');
  await cdp.eval(contentScriptCode);

  console.log('\n[4] Initial page perception...');
  const pageRep0 = await cdp.eval('window.__nexvision_extract()');
  console.log(`Page: elements=${pageRep0.elements.length}, title="${pageRep0.metadata?.title}", url="${pageRep0.metadata?.url}"`);

  const goalDescription = 'Search for MrBeast and play the first video';
  console.log(`\n[5] Decomposing goal: "${goalDescription}"...`);
  let taskPlan;
  try {
    taskPlan = await decomposeTaskGoal(goalDescription);
    console.log(`TaskPlan: archetype=${taskPlan.archetype}, phases=${taskPlan.phases.length}`);
    for (const p of taskPlan.phases) {
      console.log(`  Phase [${p.phaseIndex}]: ${p.intent} - "${p.description}"`);
    }
  } catch (err) {
    console.warn(`Decomposition fallback active: ${err.message}`);
    taskPlan = {
      planId: 'plan-fallback',
      archetype: 'search_and_act',
      summary: 'Search for MrBeast and play the first video',
      phases: [
        { phaseId: 'phase-0', phaseIndex: 0, intent: 'search', description: 'Search for MrBeast', allowedActions: ['type'] },
        { phaseId: 'phase-1', phaseIndex: 1, intent: 'select_result', description: 'Select the first video', targetHint: 'MrBeast', allowedActions: ['click'] }
      ],
      currentPhaseIndex: 0
    };
  }

  const planner = new DeterministicRulePlanner();
  const history = [];

  // ==========================================
  // STEP 0: SEARCH PHASE
  // ==========================================
  console.log('\n==================================================');
  console.log('STEP 0: SEARCH PHASE');
  console.log('==================================================');
  const activePhase0 = taskPlan.phases[0];
  const targets0 = pageRep0.elements
    .filter(el => el.interactive)
    .map(el => ({
      elementId: el.id,
      point: { x: el.bounds?.x ?? 0, y: el.bounds?.y ?? 0 },
      viewportBounds: el.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      confidence: 1.0,
      observationId: `obs-${el.id}`,
      role: el.role
    }));

  const input0 = {
    goal: { id: 'live-e2e', description: goalDescription, taskPlan },
    context: {
      page: pageRep0,
      availableTargets: targets0,
      capturedAt: Date.now(),
      currentTime: Date.now(),
      stepIndex: 0,
      phaseState: {
        activePhase: activePhase0,
        completedPhaseIds: [],
        remainingPhaseIds: taskPlan.phases.slice(1).map(p => p.phaseId),
        totalPhases: taskPlan.phases.length,
        retryCountInCurrentPhase: 0,
        phaseStatus: 'in_progress',
        phaseAttempts: 0
      }
    },
    history
  };

  const prop0 = planner.proposeStep(input0);
  console.log('Step 0 Proposal:', JSON.stringify(prop0, null, 2));

  if (prop0.status !== 'ACTION') {
    throw new Error(`Step 0 planning failed: ${prop0.reason}`);
  }

  const step0Action = prop0.proposal;
  const targetElem0 = pageRep0.elements.find(e => e.id === step0Action.targetElementId);
  console.log(`Grounded search target: id=${targetElem0.id}, role=${targetElem0.role}, tag=${targetElem0.tagName}, name="${targetElem0.accessibleName}"`);

  console.log(`\nExecuting Step 0 action: type "${step0Action.payload.text}" with pressEnter=${step0Action.payload.pressEnter}...`);
  const exec0 = await cdp.eval(`window.__nexvision_execute({
    id: "action-0",
    type: "${step0Action.actionType}",
    target: { elementId: "${step0Action.targetElementId}" },
    payload: ${JSON.stringify(step0Action.payload)}
  })`);
  console.log('Step 0 execution result:', exec0);

  if (step0Action.payload?.pressEnter) {
    console.log('Dispatching CDP Enter key event for search submission...');
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }

  history.push({
    stepIndex: 0,
    action: {
      id: 'action-0',
      type: step0Action.actionType,
      target: {
        elementId: step0Action.targetElementId,
        point: targetElem0.bounds ? { x: targetElem0.bounds.x, y: targetElem0.bounds.y } : { x: 0, y: 0 },
        viewportBounds: targetElem0.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        confidence: 1.0,
        observationId: `obs-${targetElem0.id}`,
        role: targetElem0.role
      },
      payload: step0Action.payload
    },
    perceivedOutcome: exec0.success ? 'success' : 'error',
    phaseIndex: 0,
    phaseIntent: activePhase0.intent
  });

  console.log('\nWaiting for YouTube search results page to load and render (4s)...');
  await new Promise(r => setTimeout(r, 4000));

  // Re-inject content script on the new page
  await cdp.eval(contentScriptCode);

  // ==========================================
  // STEP 1: SELECT_RESULT PHASE
  // ==========================================
  console.log('\n==================================================');
  console.log('STEP 1: SELECT_RESULT PHASE');
  console.log('==================================================');

  const pageRep1 = await cdp.eval('window.__nexvision_extract()');
  console.log(`Search Results Page: elements=${pageRep1.elements.length}, title="${pageRep1.metadata?.title}", url="${pageRep1.metadata?.url}"`);

  const activePhase1 = (taskPlan.phases.length > 1 && taskPlan.phases[1].intent === 'select_result')
    ? taskPlan.phases[1]
    : {
        phaseId: 'phase-1',
        phaseIndex: 1,
        intent: 'select_result',
        description: 'Select the first video',
        targetHint: 'MrBeast',
        allowedActions: ['click']
      };

  console.log(`Active phase: ${activePhase1.phaseId} (${activePhase1.intent}) - "${activePhase1.description}"`);

  // Log top candidate elements on search results page
  const candidateLinks = pageRep1.elements.filter(el => (el.role === 'link' || el.tagName === 'a') && el.interactive);
  console.log(`\nExamining candidate links on search results page (${candidateLinks.length} total):`);
  for (const c of candidateLinks.slice(0, 6)) {
    const isProfile = isProfileOrChannelCandidate(c);
    const isContent = isMediaContentCandidate(c);
    console.log(`  - [${c.id}] role=${c.role}, href="${c.attributes?.href}", name="${(c.accessibleName || c.visibleText || '').slice(0, 50)}..." => isProfile=${isProfile}, isContent=${isContent}`);
  }

  const targets1 = pageRep1.elements
    .filter(el => el.interactive)
    .map(el => ({
      elementId: el.id,
      point: { x: el.bounds?.x ?? 0, y: el.bounds?.y ?? 0 },
      viewportBounds: el.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      confidence: 1.0,
      observationId: `obs-${el.id}`,
      role: el.role
    }));

  const input1 = {
    goal: { id: 'live-e2e', description: goalDescription, taskPlan },
    context: {
      page: pageRep1,
      availableTargets: targets1,
      capturedAt: Date.now(),
      currentTime: Date.now(),
      stepIndex: 1,
      phaseState: {
        activePhase: activePhase1,
        completedPhaseIds: [activePhase0.phaseId],
        remainingPhaseIds: taskPlan.phases.slice(2).map(p => p.phaseId),
        totalPhases: taskPlan.phases.length,
        retryCountInCurrentPhase: 0,
        phaseStatus: 'in_progress',
        phaseAttempts: 0
      }
    },
    history
  };

  const prop1 = planner.proposeStep(input1);
  console.log('\nStep 1 Proposal:', JSON.stringify(prop1, null, 2));

  if (prop1.status !== 'ACTION') {
    throw new Error(`Step 1 planning failed: ${prop1.reason}`);
  }

  const step1Action = prop1.proposal;
  const targetElem1 = pageRep1.elements.find(e => e.id === step1Action.targetElementId);
  console.log(`Grounded result target: id=${targetElem1.id}, role=${targetElem1.role}, tag=${targetElem1.tagName}`);
  console.log(`  href: "${targetElem1.attributes?.href}"`);
  console.log(`  accessibleName: "${targetElem1.accessibleName}"`);

  // Verify that target is a VIDEO/CONTENT result and NOT a channel/profile
  const isTargetProfile = isProfileOrChannelCandidate(targetElem1);
  const isTargetContent = isMediaContentCandidate(targetElem1);
  console.log(`  Classification: isProfile=${isTargetProfile}, isContent=${isTargetContent}`);

  if (isTargetProfile) {
    throw new Error(`FAILURE: Candidate chosen (${targetElem1.id}) is a channel/profile link ("${targetElem1.attributes?.href}"), expected video content!`);
  }
  if (!isTargetContent && !targetElem1.attributes?.href?.includes('watch')) {
    console.warn(`WARNING: Target (${targetElem1.id}) may not be a standard video link: ${targetElem1.attributes?.href}`);
  } else {
    console.log(`SUCCESS: Candidate chosen (${targetElem1.id}) is a video content link!`);
  }

  console.log(`\nExecuting Step 1 action: click "${step1Action.targetElementId}"...`);
  const exec1 = await cdp.eval(`window.__nexvision_execute({
    id: "action-1",
    type: "${step1Action.actionType}",
    target: { elementId: "${step1Action.targetElementId}" }
  })`);
  console.log('Step 1 execution result:', exec1);

  history.push({
    stepIndex: 1,
    action: {
      id: 'action-1',
      type: step1Action.actionType,
      target: {
        elementId: step1Action.targetElementId,
        point: targetElem1.bounds ? { x: targetElem1.bounds.x, y: targetElem1.bounds.y } : { x: 0, y: 0 },
        viewportBounds: targetElem1.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        confidence: 1.0,
        observationId: `obs-${targetElem1.id}`,
        role: targetElem1.role
      }
    },
    perceivedOutcome: exec1.success ? 'success' : 'error',
    phaseIndex: 1,
    phaseIntent: activePhase1.intent
  });

  console.log('\nWaiting for video page navigation and playback load (5s)...');
  await new Promise(r => setTimeout(r, 5000));

  // Re-inject content script on watch page
  await cdp.eval(contentScriptCode);

  // ==========================================
  // STEP 2: WHOLE-GOAL VERIFICATION
  // ==========================================
  console.log('\n==================================================');
  console.log('STEP 2: DESTINATION PERCEPTION & GOAL VERIFICATION');
  console.log('==================================================');

  const pageRep2 = await cdp.eval('window.__nexvision_extract()');
  console.log(`Destination Page: elements=${pageRep2.elements.length}, title="${pageRep2.metadata?.title}", url="${pageRep2.metadata?.url}"`);

  // Check destination classification
  const isDestProfile = isProfileOrChannelUrl(pageRep2.metadata?.url);
  const isDestMedia = isMediaContentUrl(pageRep2.metadata?.url);
  const hasVideoElem = pageRep2.elements.some(e => e.tagName?.toLowerCase() === 'video' || e.tagName?.toLowerCase() === 'audio');
  const hasControls = pageRep2.elements.some(e => e.role === 'button' && /\b(?:play|pause|mute|unmute|seek|fullscreen|volume)\b/i.test(`${e.accessibleName ?? ''} ${e.visibleText ?? ''}`));

  console.log(`\nDestination Evidence:`);
  console.log(`  - URL: "${pageRep2.metadata?.url}"`);
  console.log(`  - isProfileOrChannelUrl: ${isDestProfile}`);
  console.log(`  - isMediaContentUrl: ${isDestMedia}`);
  console.log(`  - hasVideoElement: ${hasVideoElem}`);
  console.log(`  - hasMediaPlaybackControls: ${hasControls}`);

  const wholeGoalOutcome = verifyWholeGoalOutcome({
    goal: { id: 'live-e2e', description: goalDescription, taskPlan },
    taskPlan,
    completedPhaseIds: [activePhase0.phaseId, activePhase1.phaseId],
    currentPage: pageRep2,
    beforePage: pageRep1,
    lastAction: history[1].action,
    history
  });

  console.log('\n==================================================');
  console.log('WHOLE-GOAL VERIFICATION RESULT:');
  console.log(JSON.stringify(wholeGoalOutcome, null, 2));
  console.log('==================================================');

  cdp.close();

  if (wholeGoalOutcome.satisfied) {
    console.log('\n🎉 GOAL_SUCCESS: "Search for MrBeast and play the first video" fully satisfied!');
  } else {
    console.log(`\n❌ GOAL_FAILED: ${wholeGoalOutcome.rationale}`);
  }
}

runLiveE2E().catch(err => {
  console.error('\nLIVE E2E ERROR:', err);
  process.exit(1);
});
