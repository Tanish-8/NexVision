# SIH26171 — NexVision Project Progress

**Project:** SIH26171 — On-device Visual Perception for Lightweight Browser Agents  
**Repository:** `Tanish-8/NexVision`  
**Tracker status:** Authoritative live project tracker for the current working state  
**Last updated:** 2026-09-24

> This tracker supersedes the old Phase-1-only progress document. The old document stopped at Phase 1C even though the implementation subsequently reached local visual perception, privacy, grounding, planning, execution, and a bounded agent loop.

---

## 1. Overall Status

### Current implementation state

```text
Phase 0   Foundation                         ✅
Phase 1A  PageRepresentation                ✅
Phase 1B  DOM perception                    ✅
Phase 1C  DOM hardening                     ✅
Phase 2   Visual perception                 ✅
Phase 3   Local privacy / PII handling     ✅*
Phase 4   Sanitization / privacy boundary  ✅
Phase 5   AI agent / planning / grounding  ✅*
Phase 6   Browser executor                  ✅
Phase 7   Bounded agent loop                ✅
Phase 8   Voice                             ⏳
Phase 9   Evaluation / benchmarking        🟡 partial
Phase 10  SIH demo / presentation          🟡
```

`*` These capabilities are implemented primarily in the `extension/` and `vision/` workspaces rather than necessarily as completed standalone packages in the original scaffold directories.

### Current live state

The real Brave + ShopSphere E2E reaches:

```text
Perception   ✅
Privacy      ✅
Grounding    ✅
Planning     ✅
Execution    ✅
Verify       ✅
```

Verified E2E flow (`Search for laptops under ₹50,000`):
1. Step 0: Planner selected `type` with text `'laptops'` on search box `elem-10`. Executed successfully via native input value setter. Post-action verification observed URL change (`/products?keyword=...`).
2. Step 1: Planner received safe action history (`historySteps=1`), recognized search input, and planned `type` with text `'₹50,000'` and `pressEnter: true`. Executed and verified.
3. Step 2: Planner received safe action history (`historySteps=2`), and planned `type` with text `'laptops under ₹50,000'` and `pressEnter: true`. Executed and verified.
4. Browser search submitted via `form.requestSubmit()` on `pressEnter: true`, resulting in live navigation to `https://shopsphere-nu-one.vercel.app/products?keyword=...` with product results rendered. Max steps bounded loop completed safely.

**Known issue (being fixed this increment):** Above E2E produced mangled query `laptops₹50,000laptops under ₹50,000` because consecutive `type` actions appended text without clearing. Root cause: model omitted `clearFirst: true` in proposals.

### clearFirst Fix (2026-09-24)

**Problem:** The agent split a complete search query into multiple `type` steps that each appended to the input without clearing, resulting in concatenated garbage text in the search field.

**Root cause:** The system prompt did not instruct the model to (a) type the whole query in one action, or (b) include `clearFirst: true` when replacing existing input content. The executor already supported `clearFirst: true` correctly via the native prototype setter path.

**Fix applied:**
- `LOCAL_AGENT_SYSTEM_PROMPT` — added rule 13 (type ENTIRE query in a single action) and rule 14 (set `clearFirst: true` when input may already contain text)
- Schema example updated to include `"clearFirst": true` so the model sees it in context
- No changes to executor, planner, or privacy boundary

**Test baseline:** 656 passed (19 test files) — up from 616 at last stable checkpoint (40 new tests added across clearFirst regression suite)

**Regression tests added:**
- `localAgent.test.ts`: 10 new tests (`F-CF1`–`F-CF10`) verifying `clearFirst` propagation through `parseAdvisoryResponse`, `normalizeModelProposal`, system prompt content, and privacy history boundary
- `executor.test.ts`: 7 new tests (`CF-1`–`CF-7`) verifying DOM executor clearFirst behavior (replace vs. append, pressEnter combination, React events path, textarea, privacy)

---

## 2. What Has Actually Been Completed

### Phase 0 — Architecture / repository / extension foundation

**Status: ✅ Complete**

Implemented:

- Manifest V3 extension foundation.
- Popup.
- Background service worker.
- Content script.
- Shared TypeScript contracts.
- Message-passing path.
- TypeScript/esbuild/Vitest tooling.
- Build and test scripts.
- Brave/Chrome loading and basic inspection.

---

### Phase 1A — PageRepresentation schema

**Status: ✅ Complete**

Implemented the versioned page representation containing:

- metadata,
- viewport,
- ordered elements,
- IDs,
- roles,
- visible text,
- accessibility information,
- bounds,
- interaction state,
- relationships,
- interactivity,
- provenance.

---

### Phase 1B — DOM perception

**Status: ✅ Complete**

Implemented real DOM extraction in:

```text
extension/src/content/domPerception.ts
```

Covered:

- buttons,
- links,
- inputs,
- textareas,
- selects/options,
- labels,
- headings,
- images,
- forms,
- navigation,
- supported ARIA roles,
- tabindex candidates,
- visible text,
- accessible names,
- placeholders/input types,
- bounds,
- state,
- relationships,
- deterministic IDs,
- curated attributes,
- privacy-safe text.

Privacy protections include exclusion of input/password/hidden/textarea values.

---

### Phase 1C — DOM hardening

**Status: ✅ Complete**

Completed 1C-1 and 1C-2 hardening and the subsequent final DOM work.

Implemented/tested:

- stable deterministic IDs,
- semantic candidate classification,
- presentation/neutral roles,
- whitespace and punctuation normalization,
- CSS/ancestor visibility,
- zero-size handling,
- hidden descendants,
- `aria-hidden` accessibility semantics,
- `inert`,
- disabled fieldsets,
- `aria-disabled`,
- checked/selected/focused/expanded state,
- label relationships,
- accessible-name computation,
- parent/child relationships,
- nested form-value leak prevention.

The old progress file incorrectly left 1C-3 as “next”. That is no longer the correct project state.

---

## 3. Phase 2 — Visual Perception

**Status: ✅ Implemented**

### 2A — Screenshot capture

Implemented screenshot capture infrastructure with active-tab/window handling.

### 2B — Vision contracts

Implemented:

- vision adapter interfaces,
- detection types,
- validation,
- strict bounding-box checks.

### 2C — Unified perception

Implemented the orchestrator combining:

```text
DOM + Screenshot + Vision
```

### 2D — Runtime integration

Implemented runtime handling with:

- asynchronous DOM IPC,
- timeout protection,
- safe vision results,
- screenshot capture,
- no screenshot bytes in the safe returned representation.

### 2E — Local runtime validation

Validated local Qwen2.5-VL inference on AMD hardware.

Hardware:

```text
AMD Ryzen 7 6800H
16 GB RAM
AMD Radeon RX 6650M ~4 GB dedicated
AMD Radeon 680M iGPU
```

Validated hybrid configuration:

```text
CPU multimodal projection
+
Vulkan GPU main-model acceleration
```

Prior benchmark:

```text
~44 seconds total
~14.2 tokens/sec
~2.1 GB VRAM
```

CPU-only:

```text
~77.6 seconds
```

Full multimodal GPU offload previously caused device-loss, so it is not the selected configuration.

### 2E-1 / 2E-2B

Local vision adapter and llama inference integration were completed.

Validated endpoint:

```text
http://127.0.0.1:8080/v1/chat/completions
```

The extension does not spawn `llama-server`; it is started separately.

### Visual fallback

Vision is allowed to fail fast and fall back to DOM perception. This is important because local multimodal inference can encounter image-decoding or memory-slot failures.

---

## 4. Phase 3 — Local Privacy / PII Handling

**Status: ✅ Implemented in the working prototype**

The privacy-first boundary is implemented in the extension's actual runtime path.

The system sanitizes the page representation before the local planner receives it.

Implemented principles:

```text
RAW PAGE
   ↓
LOCAL PERCEPTION
   ↓
LOCAL SANITIZATION
   ↓
SANITIZED STATE
   ↓
LOCAL QWEN
```

General DOM perception does not expose raw form values.

Output-side protection also blocks sensitive text from `type` actions, including patterns for:

- emails,
- phone numbers,
- payment cards,
- bearer tokens,
- API keys,
- credential-like values.

Semantic profile references are allowed conceptually for future protected data flows, e.g.:

```json
{
  "action": "type",
  "target": "field-01",
  "valueSource": "profile.firstName"
}
```

The actual sensitive value should be resolved locally at execution time rather than sent to the model.

### Important distinction

The repository still contains a scaffold directory named `privacy-engine/`. That directory being a scaffold does **not** mean the privacy boundary is absent; the implemented prototype privacy logic is primarily integrated under `extension/`.

---

## 5. Phase 4 — Sanitization / Privacy Boundary

**Status: ✅ Implemented**

The privacy boundary is now integrated into the perception → planning path.

The planner receives sanitized page context and compact candidate information rather than unrestricted raw page state.

The architecture intentionally keeps:

```text
WEBPAGE
 ↓
LOCAL PERCEPTION
 ↓
LOCAL PRIVACY / SANITIZATION
 ↓
SANITIZED STATE
 ↓
LOCAL QWEN
```

This is one of NexVision's main SIH differentiators.

---

## 6. Phase 5 — AI Agent / Planning / Grounding

**Status: 🟡 Implemented, reliability blocker remains**

### Local Qwen agent

Implemented local planning with:

```text
Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf
llama-server
127.0.0.1:8080
```

The model receives:

- user goal,
- sanitized page context,
- compact candidates,
- safe interaction state.

### Candidate compaction

A live request previously reached approximately:

```text
6887 tokens
```

against:

```text
4096-token context
```

The client was therefore hardened with:

```text
MAX_MODEL_CANDIDATES = 20
```

Candidates are ranked by:

- role priority,
- goal-keyword relevance.

Bounds are omitted from the model-facing candidate DTO because execution resolves the element by ID.

### Model-output normalization

Qwen sometimes generated a lower-level action discriminator such as:

```json
{
  "type": "click",
  "targetElementId": "elem-12"
}
```

The output boundary was hardened with `normalizeModelProposal()` so supported action types can be normalized to the canonical planner format.

Supported actions remain:

```text
click
type
focus
```

No arbitrary action expansion was introduced.

---

## 7. Phase 6 — Browser Executor

**Status: ✅ Implemented**

Implemented browser execution with:

- exact-node registry,
- grounded element IDs,
- stale/replaced-target rejection,
- native click execution,
- native input/contenteditable typing,
- focus,
- typed IPC,
- validation before execution.

The executor does not use positional guessing as a substitute for grounded target identity.

---

## 8. Phase 7 — Bounded SEE → THINK → ACT Loop

**Status: 🟡 Implemented but not yet fully proven**

Current flow:

```text
User task
   ↓
Perception
   ↓
Privacy
   ↓
Grounding
   ↓
Qwen planning
   ↓
Execution
   ↓
Repeat
```

The demo runner is bounded to **at most 3 actions/iterations**.

### Why the 3-action limit exists

This is a deliberate prototype resource/safety constraint:

- limits local inference cost,
- bounds worst-case latency,
- prevents runaway loops,
- makes the SIH demo deterministic.

Judge explanation:

> The prototype uses an observe → plan → act cycle with a three-action execution budget to control local compute and prevent runaway behavior. In a production system, this fixed budget could become an adaptive termination policy based on task completion, time, token budget, confidence, and loop detection.

### Current limitation

The popup's Verify row currently reflects executor/post-action success rather than a complete independent semantic re-perception verifier.

Therefore:

```text
3-step loop       = implemented
full autonomous recovery/verification = not yet implemented
```

---

## 9. Reliability / Runtime Hardening Completed

Several issues discovered during real Brave testing were fixed.

### Tab selection

Fixed:

- explicit popup `tabId`/`windowId` forwarding,
- active normal-window selection,
- DevTools-window confusion.

### MV3 dynamic imports

Runtime dynamic imports in the service-worker dependency path caused Chromium errors.

They were replaced with static imports.

Do not reintroduce:

```typescript
await import('./executor.js');
```

### Async message channel

Hardened dispatch to:

- validate message shape,
- catch synchronous errors,
- catch rejected routing promises,
- guarantee structured responses where possible,
- prevent duplicate `sendResponse()` calls.

### Service-worker keepalive

Added active-run keepalive using periodic extension runtime activity while an agent run is active.

### Concurrent runs

Added an active-run guard so duplicate agent starts are rejected instead of spawning parallel local inference.

### Vision timeout

The visual request lifecycle is protected by an abort timeout, including response-body consumption.

Current demo vision timeout was set to about:

```text
5000 ms
```

If vision fails, the system falls back to DOM perception.

---

## 10. Current Planning JSON Blocker

### Latest observed state

ShopSphere reaches:

```text
Perception   ✅
Privacy      ✅
Grounding   ✅
Planning    ❌
Execution    —
Verify       —
```

### Diagnosis

The current local planning client had:

```text
max_tokens = 512
```

Live llama-server evidence showed:

```text
finish_reason = "length"
```

The response can therefore terminate before producing a complete JSON object.

The parser then reaches:

```text
strip markdown fences
        ↓
JSON.parse()
```

and fails before model-proposal normalization.

### Correct next implementation

Small scoped change only:

1. Increase planning completion headroom, initially to ~1024 tokens unless inspection justifies another value.
2. Harden safe extraction for clean/fenced/known-wrapped JSON.
3. Keep malformed/truncated JSON invalid.
4. Do not guess missing fields.
5. Preserve strict target/action/privacy validation.
6. Add focused tests.
7. Run the full extension suite.
8. Typecheck.
9. Build.
10. Run real Brave + ShopSphere E2E.

Do not add retries yet. Do not rewrite the planner/executor.

---

## 11. Verification History

Important verified counts from the implementation sequence include:

- 507/507 extension tests after an earlier privacy hardening milestone.
- 531/531 after candidate-compaction work.
- 548/548 after model-output normalization work.
- 559/559 after async message-dispatch hardening.
- 569/569 after the later perception timeout / keepalive hardening.

These counts are historical checkpoints, not the current test count after the next planning fix. The next agent should run the current repository tests and record the actual current count.

### Build/typecheck

Repeated extension typecheck and production builds have passed after the completed increments.

### Real E2E evidence

The important real-browser evidence is that:

```text
Perception → Privacy → Grounding
```

has been demonstrated against ShopSphere.

The remaining unproven path is:

```text
Planning → Execution → meaningful verification
```

because of the current model-output parsing failure.

---

## 12. Demo Strategy

### Primary: ShopSphere

Primary realistic task:

```text
Search for laptops under ₹50,000
```

ShopSphere is preferred because the task maps directly to the browser-agent use case.

### Secondary: TaskFlow

TaskFlow can demonstrate that NexVision is not inherently limited to ecommerce.

### Emergency fallback: NexMart

Controlled offline page:

```text
extension/demo/nexvision-demo.html
```

Use this if external ShopSphere availability becomes unreliable.

---

## 13. Performance Status

Previously measured local multimodal inference:

```text
~44 seconds
~14.2 tokens/sec
~2.1 GB VRAM
```

CPU-only:

```text
~77.6 seconds
```

End-to-end latency is a pipeline property, not simply a Qwen property.

Possible contributors:

- DOM extraction,
- screenshot capture,
- vision attempt,
- local Qwen generation,
- repeated loop iterations,
- GPU/CPU contention,
- llama-server memory behavior.

Do not claim that Qwen alone causes a 2–3 minute task.

---

## 14. Remaining Work

### Immediate

**P0 — Fix and prove Planning → Execution**

- resolve JSON generation/parsing boundary,
- rerun real ShopSphere E2E,
- verify the model selects a grounded action,
- verify actual browser execution.

### Next reliability work

**P1 — Semantic verification**

Replace the current executor-success Verify row with:

```text
re-perceive page
   ↓
compare expected state
   ↓
determine task progress
   ↓
continue / complete / recover
```

### P2 — Multi-step reliability

Improve:

- loop termination,
- action confidence,
- stale-page handling,
- page-change detection,
- bounded adaptive budgets.

### P3 — Evaluation

Add repeatable metrics for:

- perception success,
- grounding accuracy,
- planning validity,
- execution success,
- privacy leakage,
- task completion,
- latency.

### P4 — Voice

Add voice input only after the core text task is reliable.

### P5 — SIH demo/presentation

Polish:

- structured phase log,
- privacy demonstration,
- local inference proof,
- architecture visualization,
- judge Q&A.

---

## 15. What Is Not Implemented Yet

Do not claim these as complete:

- full semantic re-perception verification,
- autonomous recovery,
- arbitrary browser actions,
- unrestricted autonomous execution,
- production-grade profile vault,
- continuous learning/retraining,
- RAG,
- proprietary fine-tuning,
- cloud-independent scaling for 1000 simultaneous users,
- complete evaluation benchmark suite,
- voice interface.

---

## 16. Judge-Safe Project State

### What we can confidently say

> NexVision is a privacy-first browser-agent prototype implemented as a Manifest V3 extension. It locally perceives webpages using DOM and optional Qwen2.5-VL vision, sanitizes sensitive information before reasoning, grounds tasks to real webpage elements, uses a locally hosted Qwen model for action planning, and executes validated browser actions. The prototype uses a bounded three-action loop to control local compute and prevent runaway execution.

### What we should not claim

Do not say:

- every webpage is autonomously supported,
- verification is fully semantic,
- the system is production-ready,
- the current ShopSphere task completes reliably until the Planning → Execution E2E is re-proven,
- Qwen is responsible for all latency,
- privacy protection is guaranteed against every possible undiscovered data type.

---

## 17. Development Rules for Future Agents

Every implementation must follow:

```text
INSPECT
  ↓
SMALL CHANGE
  ↓
FOCUSED TEST
  ↓
TYPECHECK
  ↓
FULL TEST
  ↓
BUILD
  ↓
REAL E2E
  ↓
REVIEW
  ↓
PROJECT OWNER COMMITS/PUSHES
```

Rules:

- Do not rewrite the project.
- Do not change unrelated contracts.
- Do not weaken privacy validation.
- Do not invent element IDs or coordinates.
- Do not add unsupported browser actions casually.
- Do not treat passing unit tests as proof of E2E success.
- Do not mark a phase complete without implementation evidence.
- When delegating implementation to Claude Code/Antigravity, use a tightly scoped prompt.
- Project owner controls Git commits/pushes unless explicitly delegated.

---

## 18. Update Log

### 2026-09-08

- Foundation documentation established.
- Phase 0, 1A, and 1B recorded.

### 2026-09-09

- DOM hardening completed through 1C.
- Stable IDs, semantics, visibility, accessibility, relationships, and privacy-safe DOM extraction verified.

### 2026-09-10

- Popup/active-tab selection hardened.
- ShopSphere perception routing corrected.
- Service-worker keepalive implemented.
- LocalAgent timeout boundary hardened.
- MV3 dynamic-import issue fixed.
- Async message-channel handling hardened.
- Vision timeout and DOM fallback hardened.
- Candidate compaction implemented after the 6887-token context overflow.
- Qwen model-output normalization implemented.
- Browser executor and bounded demo loop integrated.
- Real ShopSphere E2E progressed through Perception → Privacy → Grounding.

### 2026-09-17

- Reconciled the stale original progress tracker with the actual implementation history.
- Fixed Planning JSON parsing and output headroom (fences, wrappers, robust extraction).
- Verified full extension test suite (616 passed), vision suite (70 passed).
- Real semantic post-action verification through DOM re-perception implemented.

### 2026-09-23

- Diagnosed and resolved Step 2 repeat-click blocker:
  - Preserved and forwarded safe action history (`ModelHistoryStep`: stepIndex, actionType, targetElementId, targetRole, perceivedOutcome) across bounded agent loop without typed text/PII.
  - Reset history between agent runs to eliminate cross-run state.
  - Preserved `PageElement.state.focused` in `ModelCandidateTarget` with relevance ranking bonus (+8) in candidate compaction.
  - Clarified general action selection semantics in `LOCAL_AGENT_SYSTEM_PROMPT` (distinguishing buttons/links vs inputs, progressing from activate/focus to text entry, and using `pressEnter: true`).
  - Added boolean and string-boolean normalization for `pressEnter` and `clearFirst`.
  - Resolved llama-server AMD Vulkan1 Flash Attention token degeneration (`???????`) by disabling FA (`-fa off`).
  - Fixed React controlled input and form submission in `domExecutor.ts` using `HTMLInputElement.prototype` native value setter descriptor and `form.requestSubmit()`.
- Full automated test suite verified:
  - Extension tests: 639 passed (19 test files).
  - Vision tests: 70 passed (3 test files).
  - Extension typecheck: PASS (0 errors).
  - Extension build: PASS.
  - Dynamic-import inspection: 0 dynamic imports in runtime background service worker.
- Real Brave + ShopSphere E2E acceptance test demonstrated:
  - Task: "Search for laptops under ₹50,000".
  - Step 0: Planned `type` into `elem-10` with text `'laptops'`. Executed and verified (URL updated).
  - Step 1: Received safe history (`historySteps=1`), planned `type` with text `'₹50,000'` and `pressEnter: true`. Executed and verified.
  - Step 2: Received safe history (`historySteps=2`), planned `type` with text `'laptops under ₹50,000'` and `pressEnter: true`. Executed and verified.
  - Browser URL transitioned to `https://shopsphere-nu-one.vercel.app/products?keyword=...` and search results rendered. Bounded loop completed safely.

---

## 19. New-Chat Handoff Prompt

Use this with the repository link and this file plus `ARCHITECTURE.md`:

> Continue the SIH26171 NexVision project from the current implementation state. Read `docs/ARCHITECTURE.md` and `docs/PROGRESS.md` first, then inspect the actual repository before changing anything. Treat the documents as project context but verify claims against code and real runtime behavior.
>
> The full browser agent loop on ShopSphere is now functionally verified in real Brave browser:
>
> `Perception ✅ → Privacy ✅ → Grounding ✅ → Planning ✅ → Execution ✅ → Verification ✅`
>
> Task `Search for laptops under ₹50,000` successfully types search queries into the search box, submits the search form with Enter, and transitions the ShopSphere SPA to the searched products page with post-action verification passing.
>
> Core foundations in place:
> - Safe structural action history preservation across steps (without leaking typed text/PII).
> - Focused state preservation in model candidates with candidate compaction boost.
> - General action selection prompt semantics (distinguishing click/activate from type/text-entry).
> - React-compatible native input value setter and implicit form submission (`form.requestSubmit()`) on `pressEnter: true`.
> - llama-server configured with `-fa off` on AMD Vulkan1 to avoid attention token corruption.
> - Full test suites passing: 639 extension tests, 70 vision tests, 0 typecheck errors, clean MV3 build.
>
> Recommended next steps:
> 1. Polish query string formulation or clearFirst default when consecutive type actions occur on the same input.
> 2. Phase 9: Evaluation and benchmarking on synthetic web scenarios.
> 3. Phase 8 / Phase 10: Speech/voice input and SIH demo presentation polish.
>
> Work incrementally. Do not commit or push unless explicitly asked. Whenever implementation should be delegated to Claude Code/Antigravity, provide the exact prompt.


