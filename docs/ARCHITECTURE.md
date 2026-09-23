# SIH26171 — NexVision Architecture

**Project:** SIH26171 — On-device Visual Perception for Lightweight Browser Agents  
**Repository:** `Tanish-8/NexVision`  
**Document status:** Current architectural source of truth for handoff  
**Last updated:** 2026-09-17

> This document reflects the implementation reached by the project, not the original roadmap. Implemented behavior, verified limitations, and future work are kept separate.

---

## 1. Project Objective

NexVision is a privacy-first browser-agent prototype for SIH26171. It lets a lightweight browser agent perceive webpages, reason about the current page, and execute browser actions while keeping webpage perception and sensitive-data handling local.

The central architectural principle is:

```text
WEBPAGE
   ↓
LOCAL PERCEPTION
   ├── DOM
   └── SCREENSHOT / VISION
   ↓
UNIFIED PAGE REPRESENTATION
   ↓
LOCAL PRIVACY / SANITIZATION
   ↓
SANITIZED PAGE STATE
   ↓
TASK ↔ ELEMENT GROUNDING
   ↓
LOCAL QWEN PLANNER / AGENT
   ↓
VALIDATED ACTION
   ↓
BROWSER EXECUTOR
   ↓
PAGE CHANGES
   ↓
RE-PERCEPTION / VERIFICATION
   ↺
```

The current prototype implements most of this path, but it remains bounded and has known reliability limitations.

---

## 2. Current Implementation Snapshot

### Implemented and verified

- Chrome/Brave Manifest V3 extension.
- Popup → background service-worker → content-script messaging.
- Structured `PageRepresentation`.
- Hardened DOM perception with stable per-representation element IDs.
- Semantic roles, accessibility names, state, bounds, relationships, and provenance.
- Screenshot capture infrastructure.
- Local Qwen2.5-VL inference through `llama-server`.
- Vision adapter with strict detection validation.
- Unified DOM + vision perception orchestration.
- DOM-only fallback when visual inference fails or times out.
- Screenshot/viewport coordinate normalization.
- Deterministic visual/DOM grounding.
- `ActionTarget` / `IntendedAction` contracts.
- Planner validation boundary.
- Browser executor for `click`, `type`, and `focus`.
- Local privacy/sanitization boundary.
- Output-side protection for sensitive `type` actions.
- Local Qwen agent/planner.
- Model-output normalization for common Qwen schema variations.
- Candidate compaction (`MAX_MODEL_CANDIDATES = 20`) to control context size.
- MV3 static-import rule and service-worker async-response hardening.
- Service-worker keepalive during active local inference.
- Fast vision timeout with DOM fallback.
- Bounded demo agent loop of at most 3 action iterations.
- Controlled offline NexMart demo page.
- ShopSphere as the primary realistic demo target.
- TaskFlow as a secondary realistic target.
- CI checks for extension typecheck/tests/build.

### Current blocker

The latest verified ShopSphere E2E reaches:

```text
Perception   ✅
Privacy      ✅
Grounding   ✅
Planning    ❌  Failed to parse model output as valid JSON
Execution    —
Verify       —
```

The current diagnosis is that the local Qwen planning response can hit the configured completion limit (`max_tokens: 512`) and return `finish_reason: "length"`, leaving malformed/truncated JSON before `JSON.parse()` can reach `normalizeModelProposal()`.

**Do not claim Planning → Execution is fixed until a fresh Brave + ShopSphere E2E proves it.**

---

## 3. Repository Structure

```text
NexVision/
├── .claude/
├── .github/
├── agent/
├── backend/
├── docs/
│   ├── ARCHITECTURE.md
│   └── PROGRESS.md
├── evaluation/
├── extension/
│   ├── demo/
│   │   └── nexvision-demo.html
│   ├── src/
│   │   ├── background/
│   │   │   ├── service-worker.ts
│   │   │   ├── screenshot.ts
│   │   │   ├── orchestrator.ts
│   │   │   ├── localAgent.ts
│   │   │   ├── llamaVisionAdapter.ts
│   │   │   ├── executor.ts
│   │   │   └── demoRunner.ts
│   │   ├── content/
│   │   │   ├── content-script.ts
│   │   │   ├── domPerception.ts
│   │   │   └── domExecutor.ts
│   │   ├── popup/
│   │   │   ├── popup.html
│   │   │   ├── popup.ts
│   │   │   └── styles.css
│   │   └── shared/
│   │       ├── types.ts
│   │       ├── messaging.ts
│   │       ├── coordinates.ts
│   │       ├── grounding.ts
│   │       ├── actions.ts
│   │       └── planner.ts
│   ├── manifest.json
│   └── dist/
├── privacy-engine/
└── vision/
    └── src/
```

The working prototype currently lives primarily under `extension/` and `vision/`. Scaffold directories must not be treated as proof of missing functionality without checking the actual implementation.

---

## 4. Runtime Architecture

### 4.1 Popup

The popup provides:

- Agent task input.
- `Run Agent`.
- Six-phase status log:
  - Perception
  - Privacy
  - Grounding
  - Planning
  - Execution
  - Verify
- Page inspection information.

The popup explicitly resolves the active normal tab and forwards its `tabId` and `windowId` with agent requests.

### 4.2 Service Worker

The MV3 service worker:

- Routes extension messages.
- Resolves active tabs when required.
- Runs the bounded demo-agent orchestration.
- Calls perception, planning, and execution components.
- Uses **static ES imports**. Runtime dynamic `import()` must not be introduced into the service-worker dependency path.
- Uses a keepalive heartbeat during active agent runs.
- Rejects concurrent agent runs.
- Uses hardened message dispatch so asynchronous failures still produce structured responses.
- Handles the agent-run lifecycle and progress events.

### 4.3 Content Script

The content script:

- Receives perception/inspection requests.
- Extracts the DOM representation.
- Executes supported DOM-local browser actions when requested by the executor.
- Uses the shared hardened messaging path.

---

## 5. PageRepresentation Contract

`PageRepresentation` is the main boundary between perception and later components.

It includes:

- Schema version.
- Page metadata.
- Viewport dimensions in CSS pixels.
- Ordered elements.
- Stable IDs within a representation.
- Tag name.
- Semantic role.
- Visible text.
- Accessible name.
- Placeholder/input type where appropriate.
- Bounds.
- Interaction state.
- Interactive flag.
- Curated attributes.
- Parent/child relationships.
- Label relationships.
- Provenance: `dom`, `vision`, or `both`.

### Privacy rule

General DOM perception does **not** serialize:

- raw user-entered input values,
- passwords,
- hidden-input values,
- textarea values.

Element IDs such as `elem-1` are deterministic within one representation but are not permanent identifiers across arbitrary page reloads.

---

## 6. DOM Perception

`extension/src/content/domPerception.ts` is implemented and heavily tested.

It handles:

- Native interactive elements.
- Meaningful content.
- Headings, images, forms, navigation.
- Supported ARIA roles.
- Deterministic document-order IDs.
- Normalized text.
- Accessible-name computation.
- Associated labels and `labelIds`.
- CSS/ancestor visibility.
- Zero-size elements.
- Hidden inputs.
- Disabled controls and disabled fieldsets.
- `aria-disabled`.
- `inert`.
- Checked/selected/focused/expanded state.
- Parent/child relationships.
- Curated attributes.
- Privacy-safe ancestor text.
- `aria-hidden` as accessibility semantics rather than visual invisibility.

DOM perception is the reliable fallback when visual inference is unavailable.

---

## 7. Visual Perception

Local visual inference uses `llama.cpp` `llama-server`.

### Current model/runtime

```text
Model:
Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf

Multimodal projection:
mmproj-Qwen2.5-VL-Instruct-Q8_0.gguf

Runtime:
llama.cpp llama-server

Endpoint:
http://127.0.0.1:8080

GPU backend:
Vulkan1

Launch configuration:
--no-mmproj-offload
-ngl 99
--device Vulkan1
--host 127.0.0.1
--port 8080
-c 4096
-t 8
```

The exact cached mmproj filename used in the validated runtime is recorded in the project progress/handoff notes; keep the actual local model filename as the source of truth.

The extension does **not** spawn the server. `llama-server.exe` is started separately.

### Visual adapter behavior

The adapter has:

- Local HTTP inference.
- Abort/timeout handling.
- HTTP status handling.
- Response-body timeout coverage.
- Strict detection/bounding-box validation.
- Privacy-safe error reporting.

### Hardware limitation

Previously validated hardware:

```text
CPU: AMD Ryzen 7 6800H
RAM: 16 GB
GPU: AMD Radeon RX 6650M ~4 GB dedicated
iGPU: AMD Radeon 680M
```

Full multimodal GPU offload previously produced a device-loss failure. The validated configuration uses CPU for the multimodal projection path and Vulkan GPU acceleration for the main model.

Visual inference can also fail because of image-decoding/memory-slot behavior in `llama-server`; the extension therefore times out quickly and falls back to DOM perception.

---

## 8. Unified Perception

The orchestrator combines:

```text
DOM provider
+
Screenshot provider
+
Vision provider
```

Behavior:

1. Obtain the DOM representation.
2. Capture/obtain screenshot data.
3. Attempt local visual perception.
4. If vision succeeds, combine visual observations with DOM evidence.
5. If vision fails or times out, continue with DOM-only perception.
6. Report the failure origin without exposing raw page data in the safe result.

A typical ShopSphere run may therefore report:

```text
DOM-only (no llama-server)
```

This is an intentional fallback state, not necessarily a crash.

---

## 9. Coordinate Space

The implementation distinguishes:

- DOM bounds: CSS viewport coordinates.
- Screenshot detections: screenshot pixel coordinates.
- Device-pixel-ratio metadata.

Grounding uses measured screenshot-to-viewport scaling rather than blindly assuming DPR is always the scale factor.

Previously measured example:

```text
Screenshot: 1295 × 877
Viewport:   1036 × 702
DPR:        1.25

Scale X: 1.25
Scale Y: ~1.2493
```

Invalid coordinates are not silently clamped.

---

## 10. Grounding

`extension/src/shared/grounding.ts` implements deterministic target grounding.

Current score:

```text
0.45 IoU
0.20 visual containment
0.15 element containment
0.20 center proximity
```

Semantic labels receive stronger relevance than generic labels. Tie-breaking is deterministic.

The DOM-only path can resolve actionable DOM elements into action targets. Counts vary by page and viewport; recent ShopSphere runs have produced roughly 110–115 interactive targets.

---

## 11. Action Contracts and Planner Boundary

Supported action types are intentionally narrow:

```text
click
type
focus
```

Pipeline:

```text
Model proposal
   ↓
normalize model proposal
   ↓
strict advisory validation
   ↓
planner validation
   ↓
ActionTarget resolution
   ↓
executor
```

The model must not invent:

- element IDs,
- coordinates,
- credentials,
- unsupported actions.

The model-facing candidate DTO is compact and omits bounds because the executor resolves actions by grounded element ID.

---

## 12. Local Qwen Agent / Planner

`extension/src/background/localAgent.ts` implements the local planning boundary.

The client sends requests to:

```text
http://127.0.0.1:8080/v1/chat/completions
```

The model receives:

- user goal,
- sanitized page context,
- compact candidate elements,
- safe state needed for action selection.

It does not receive unnecessary raw private values.

### Candidate compaction

`MAX_MODEL_CANDIDATES = 20`.

Candidates are ranked using role priority and goal-keyword relevance. Bounds are omitted from the model-facing DTO.

This was introduced after a live request of about 6887 tokens exceeded the server's 4096-token context.

### Model-output normalization

`normalizeModelProposal()` handles common Qwen schema variations, including a lower-level action discriminator such as:

```json
{
  "type": "click",
  "targetElementId": "elem-42"
}
```

which can be normalized to the canonical action wrapper expected by the planner.

It also supports safe target-ID aliases and root-level type text while preserving strict validation.

### Output-side privacy

Sensitive values such as emails, phone numbers, payment-card numbers, bearer tokens, API keys, and similar credential-like text are blocked from `type` actions unless represented through an approved semantic profile reference.

---

## 13. Current Planning Output Blocker

The latest live ShopSphere issue remains:

```text
Planning
Failed — Failed to parse model output as valid JSON
```

Current diagnosis:

- `parseAdvisoryResponse()` can fail at `JSON.parse(cleaned)` before `normalizeModelProposal()`.
- Markdown-fence stripping is intentionally narrow.
- Candidate compaction is already active.
- The local client was using `max_tokens: 512`.
- Live llama-server evidence showed a planning completion reaching the length limit with `finish_reason: "length"`.
- A truncated completion can therefore produce malformed JSON.

### Safe next fix

The next implementation should be small and focused:

1. Increase the planning completion budget, initially to about 1024 tokens unless code inspection gives a strong reason otherwise.
2. Make JSON extraction tolerant of known safe wrappers/fences.
3. Do not repair truncated JSON by guessing missing fields.
4. Preserve strict proposal validation and privacy checks.
5. Add regression tests.
6. Re-run the real Brave + ShopSphere E2E.

Do not add retries or a generic LLM-output-repair subsystem until the direct fix has been tested.

---

## 14. Privacy Architecture

The intended privacy boundary is:

```text
WEBPAGE
   ↓
LOCAL PERCEPTION
   ↓
LOCAL PRIVACY / SANITIZATION
   ↓
MINIMAL SANITIZED STATE
   ↓
LOCAL QWEN
```

Sensitive values should not be sent merely because they are present in the DOM.

For future protected profile data, the conceptual contract is:

```json
{
  "action": "type",
  "target": "field-01",
  "valueSource": "profile.firstName"
}
```

with:

```text
LOCAL PROFILE / VAULT
        ↓
LOCAL EXECUTOR
        ↓
WEBPAGE
```

rather than:

```text
LOCAL PROFILE
      ↓
LLM / SERVER
      ↓
WEBPAGE
```

Current implementation includes local sanitization and output-side sensitive-type protection. A production-grade persistent profile vault remains future work.

---

## 15. Demo Agent Loop

The current SIH demo integration is intentionally bounded.

```text
Popup task
   ↓
RUN_AGENT_STEP_REQUEST
   ↓
Perceive
   ↓
Sanitize
   ↓
Ground
   ↓
Local Qwen planning
   ↓
Execute
   ↓
Repeat
```

The current demo runner allows **at most 3 actions/iterations**.

This is a deliberate prototype resource/safety guardrail. It limits runaway local inference and bounds worst-case compute/latency.

Judge-safe explanation:

> The agent loop is implemented as an observe → plan → act cycle. The current prototype imposes a three-action execution budget to control local compute, latency, and runaway behavior. Production would replace the fixed budget with an adaptive termination policy based on task completion, time, token budget, confidence, and loop detection.

### Verification limitation

The current `Verify` popup row is **not** a complete independent semantic verifier. It currently reflects executor-reported success/post-action confirmation rather than a full re-perception-based task verifier.

Do not claim full autonomous verification/recovery until that capability is implemented and tested.

---

## 16. Demo Targets

### Primary

ShopSphere:

```text
https://shopsphere-nu-one.vercel.app/
```

Example:

```text
Search for laptops under ₹50,000
```

### Secondary

TaskFlow can be used to demonstrate that the architecture is not inherently ecommerce-specific.

### Emergency fallback

```text
extension/demo/nexvision-demo.html
```

The controlled NexMart page is deterministic and offline-friendly.

---

## 17. Service-Worker Reliability Rules

Do not reintroduce runtime dynamic imports such as:

```typescript
await import('./executor.js');
```

Use static imports in the MV3 service-worker dependency path.

The messaging layer now:

- validates message shape,
- catches synchronous failures,
- catches rejected routing promises,
- returns structured errors where possible,
- prevents duplicate `sendResponse()` calls,
- preserves the asynchronous response contract.

The service worker also has:

- active-run concurrency protection,
- keepalive during active agent execution.

---

## 18. Performance Facts

Previously validated local multimodal benchmark:

```text
~44 seconds total
~14.2 tokens/sec
~2.1 GB VRAM
```

CPU-only benchmark:

```text
~77.6 seconds
```

These are measurements on the specific local hardware, not universal NexVision latency.

Total task latency can include:

- DOM extraction,
- screenshot capture,
- visual inference attempt,
- local Qwen planning,
- execution,
- repeated iterations,
- GPU/CPU contention,
- llama-server memory behavior.

Therefore, a 2–3 minute end-to-end task should **not** be attributed solely to Qwen.

---

## 19. What NexVision Is and Is Not

NexVision is:

- a privacy-first browser-agent prototype,
- locally perceived,
- locally sanitized,
- locally planned with Qwen,
- grounded to real webpage elements,
- capable of executing a narrow set of browser actions,
- bounded to prevent runaway execution.

NexVision is not currently:

- a production-ready general browser agent,
- an unrestricted autonomous agent,
- a system supporting arbitrary browser actions,
- a full semantic verification/recovery system,
- an RAG system,
- a proprietary fine-tuned model,
- a continuously retrained system,
- dependent on a cloud LLM for the current local inference path,
- guaranteed to complete arbitrary webpages autonomously.

---

## 20. Phase Mapping

The original roadmap used phases for planning. The implementation has progressed beyond the original Phase 1C/Phase 4 documentation.

Current practical mapping:

```text
Phase 0  Foundation                         ✅
Phase 1A PageRepresentation                 ✅
Phase 1B DOM perception                     ✅
Phase 1C DOM hardening                      ✅
Phase 2  Visual perception                  ✅
Phase 3  Local privacy / PII boundary      ✅* 
Phase 4  Sanitization / privacy boundary   ✅
Phase 5  AI agent / planning / grounding   ✅*
Phase 6  Browser executor                   ✅
Phase 7  Bounded SEE → THINK → ACT demo     🟡
Phase 8  Voice                               ⏳
Phase 9  Evaluation / benchmarking          🟡/partial
Phase 10 SIH demo / presentation            🟡
```

`*` The project uses a pragmatic implementation of these phases inside the extension rather than a separately completed standalone package under the scaffold directories.

Phase 7 is **not** marked fully complete because the current planning-output blocker prevents reliable Planning → Execution, and Verify is not yet an independent semantic verifier.

---

## 21. Development Workflow

Every implementation increment should follow:

```text
INSPECT CURRENT CODE
        ↓
SMALL SCOPED CHANGE
        ↓
FOCUSED TESTS
        ↓
TYPECHECK
        ↓
FULL TEST SUITE
        ↓
BUILD
        ↓
REAL MANUAL / E2E TEST
        ↓
REVIEW
        ↓
COMMIT / PUSH BY PROJECT OWNER
```

Do not rewrite the project in one step.

Do not modify unrelated architecture.

Do not weaken privacy or validation just to make a test pass.

Do not mark a milestone complete without evidence.

---

## 22. Judge-Safe One-Sentence Architecture

> **NexVision is a browser extension that locally perceives the webpage, sanitizes sensitive information before reasoning, grounds the user's task to real webpage elements, uses a locally hosted Qwen2.5-VL model to select a safe action, executes that action in the browser, and iteratively re-observes the page within a bounded execution budget.**
