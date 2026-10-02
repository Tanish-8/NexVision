/**
 * Real Runtime Validation for NexVision Demo
 *
 * Exercises the end-to-end pipeline without DOM injection shortcuts:
 *   runDemoAgentWithProvider()
 *   → decomposeTaskGoal() via llama-server (http://127.0.0.1:8080)
 *   → normalizeDecomposedTaskPlan()
 *   → LocalAgentDriver via llama-server
 *   → model proposal & normalization (enforces structured targetValue)
 *   → browser executor (executeDomAction in real page)
 *   → re-perception (extractPageRepresentationFromDom in real page)
 *   → phase advancement (search -> select_result)
 *   → result selection (click latest Amazon row txn-001)
 *   → modal verification & whole-goal verification -> GOAL_SUCCESS
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEMO_URL = 'file:///C:/Users/madis/OneDrive/Desktop/SIH/extension/demo/nexvision-demo.html';

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
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`Eval exception: ${JSON.stringify(res.exceptionDetails)}`);
    return res.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('NexVision Real Runtime Live Validation');
  console.log('='.repeat(70));

  // 1. Connect to Chrome via CDP
  const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const nexBankTab = tabs.find(t => t.url && t.url.includes('nexvision-demo.html')) || tabs.find(t => t.type === 'page');
  if (!nexBankTab) {
    throw new Error('No Chrome tab found for nexvision-demo.html');
  }
  console.log(`[CDP] Connecting to tab ${nexBankTab.id} (${nexBankTab.title})...`);
  const cdp = new CDPClient(nexBankTab.webSocketDebuggerUrl);
  await cdp.connect();

  // 2. Bring to front and ensure fresh page state
  await cdp.send('Page.bringToFront');
  await cdp.send('Page.navigate', { url: DEMO_URL });
  await new Promise(r => setTimeout(r, 1500));

  // 3. Inject compiled content-script so DOM perception & execution run in the real browser
  console.log('[ContentScript] Injecting compiled content-script...');
  const contentScriptPath = path.resolve(__dirname, '../dist/content/content-script.js');
  let contentScript = fs.readFileSync(contentScriptPath, 'utf-8');
  contentScript = contentScript.replace(
    /}\)\(\);?\s*$/,
    `  window.__nexvision_extract = extractPageRepresentationFromDom;\n  window.__nexvision_execute = executeDomAction;\n})();`
  );
  await cdp.eval(contentScript);

  // 4. Setup globalThis.chrome bridge for background modules running in Node
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: DEMO_URL }),
      query: async () => [{ id: 1, url: DEMO_URL, active: true }],
      sendMessage: async (tabId, message) => {
        if (message.type === 'execute-action-request' || message.type === 'execute-action' || (typeof message.type === 'string' && message.type.includes('execute'))) {
          const action = message.payload?.action ?? message.payload;
          const execRes = await cdp.eval(`window.__nexvision_execute(${JSON.stringify(action)})`);
          return { success: execRes.success, data: execRes };
        }
        return { success: false, error: 'Unknown message type: ' + message.type };
      },
      captureVisibleTab: async () => {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        return `data:image/png;base64,${shot.data}`;
      }
    },
    runtime: {
      sendMessage: async () => ({ success: true })
    }
  };

  // 5. Define domProvider backed directly by the real in-page perception engine
  const domProvider = async () => {
    return await cdp.eval('window.__nexvision_extract()');
  };

  // Verify initial page perception
  const initialRep = await domProvider();
  console.log(`[Perception] Initial page elements: ${initialRep.elements.length}, interactive: ${initialRep.elements.filter(e => e.interactive).length}`);

  // 6. Import compiled demoRunner
  const { runDemoAgentWithProvider } = await import('../dist/background/demoRunner.js');

  const goalText = 'Find my latest Amazon transaction.';
  console.log(`\n[Agent] Starting runDemoAgentWithProvider with goal: "${goalText}"\n`);

  const progressEvents = [];
  const result = await runDemoAgentWithProvider(
    1,
    undefined,
    goalText,
    domProvider,
    (event) => {
      progressEvents.push(event);
      console.log(`  [Progress] Step ${event.stepIndex} | Phase: ${event.phase} | Status: ${event.status} | ${event.message}`);
    }
  );

  console.log('\n' + '='.repeat(70));
  console.log('Demo Execution Result:');
  console.log('='.repeat(70));
  console.log(`Run ID:      ${result.runId}`);
  console.log(`Status:      ${result.status}`);
  console.log(`Total Steps: ${result.steps.length}`);
  console.log(`Summary:     ${result.summary}`);

  // Inspect each step
  result.steps.forEach((step, idx) => {
    console.log(`\n--- Step ${idx} ---`);
    console.log(`Plan Status:   ${step.plan.status}`);
    console.log(`Action Type:   ${step.plan.actionType}`);
    console.log(`Target Element:${step.plan.targetElementId}`);
    console.log(`Rationale:     ${step.plan.rationale}`);
    console.log(`Execution:     success=${step.execution?.success}`);
    console.log(`Verification:  ${step.verification?.summary ?? JSON.stringify(step.verification)}`);
  });

  // Verify browser final state via CDP
  const finalBrowserState = await cdp.eval(`
    (() => {
      const searchInput = document.querySelector('[name="transaction_search"]');
      const statusText = document.querySelector('.search-status')?.textContent;
      const modal = document.querySelector('.txn-detail-overlay');
      const modalVisible = modal && window.getComputedStyle(modal).display !== 'none';
      const merchant = document.querySelector('[data-detail="merchant"]')?.textContent;
      const amount = document.querySelector('[data-detail="amount"]')?.textContent;
      const date = document.querySelector('[data-detail="date"]')?.textContent;
      const txnId = document.querySelector('[data-detail="txnId"]')?.textContent;
      const visibleRows = Array.from(document.querySelectorAll('.txn-table tbody tr'))
        .filter(r => r.style.display !== 'none')
        .map(r => ({
          txn: r.getAttribute('data-txn'),
          merchant: r.getAttribute('data-merchant'),
          date: r.getAttribute('data-date')
        }));

      return {
        typedSearchValue: searchInput ? searchInput.value : null,
        statusText,
        visibleRowsCount: visibleRows.length,
        visibleRows,
        modalVisible,
        modalDetails: { merchant, amount, date, txnId }
      };
    })()
  `);

  console.log('\n' + '='.repeat(70));
  console.log('Final Browser DOM State:');
  console.log('='.repeat(70));
  console.log(`Search Input Value:   "${finalBrowserState.typedSearchValue}"`);
  console.log(`Status Text:          "${finalBrowserState.statusText}"`);
  console.log(`Visible Rows Count:   ${finalBrowserState.visibleRowsCount}`);
  console.log(`Modal Visible:        ${finalBrowserState.modalVisible}`);
  console.log(`Modal Details:        `, finalBrowserState.modalDetails);

  cdp.close();

  // Assertions for clean exit code
  const step0 = result.steps[0];
  const step1 = result.steps[1];

  let errors = [];
  if (finalBrowserState.typedSearchValue !== 'Amazon') {
    errors.push(`Expected search input value "Amazon", got "${finalBrowserState.typedSearchValue}"`);
  }
  if (finalBrowserState.visibleRowsCount !== 5) {
    errors.push(`Expected 5 visible Amazon rows, got ${finalBrowserState.visibleRowsCount}`);
  }
  if (!finalBrowserState.modalVisible) {
    errors.push('Expected transaction detail modal to be visible');
  }
  if (finalBrowserState.modalDetails?.merchant !== 'Amazon') {
    errors.push(`Expected modal merchant "Amazon", got "${finalBrowserState.modalDetails?.merchant}"`);
  }
  if (finalBrowserState.modalDetails?.date !== '30 Sep 2026') {
    errors.push(`Expected modal date "30 Sep 2026", got "${finalBrowserState.modalDetails?.date}"`);
  }
  if (finalBrowserState.modalDetails?.txnId !== 'TXN-928374') {
    errors.push(`Expected modal txnId "TXN-928374", got "${finalBrowserState.modalDetails?.txnId}"`);
  }
  if (result.status !== 'COMPLETED') {
    errors.push(`Expected result.status "COMPLETED", got "${result.status}"`);
  }
  if (!result.message?.includes('Whole goal verified')) {
    errors.push(`Expected whole goal verification in result.message, got "${result.message}"`);
  }

  if (errors.length > 0) {
    console.error('\n❌ VALIDATION FAILED:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  } else {
    console.log('\n✅ ALL LIVE RUNTIME CHECKS PASSED PERFECTLY!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\n❌ Unhandled error during validation:', err);
  process.exit(1);
});
