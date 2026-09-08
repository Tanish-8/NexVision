# SIH26171 Architecture

**Project:** SIH26171  
**Problem statement:** On-device Visual Perception for Lightweight Browser Agents  
**GitHub repository:** NexVision  
**Document status:** Long-term architecture and development workflow  
**Current implementation status:** Phase 0 complete; Phase 1A and Phase 1B complete; Phase 1C is next.

> This document is the architectural source of truth. It describes the current repository accurately and separates implemented behavior from planned behavior. Future implementation work must read this document and `docs/PROGRESS.md` before changing code.

## Mandatory Development & Progress Tracking Workflow

`docs/PROGRESS.md` is the authoritative live project tracker.

For every future implementation task:

1. Read `docs/ARCHITECTURE.md` and `docs/PROGRESS.md` first.
2. Inspect the current implementation before editing.
3. Implement only the requested scope.
4. Run the appropriate tests, typecheck, build, and manual verification.
5. Update `docs/PROGRESS.md` in the same task with the files changed, verification results, current phase, milestone, completion estimate, remaining work, next step, and real blockers.
6. Commit the implementation and documentation when the task is complete.
7. Update this architecture document only when an actual architectural decision or structural change occurs. Do not rewrite it for every small code change.
8. Never mark a phase, milestone, or feature complete without corresponding verification.

**Every completed implementation task MUST update `docs/PROGRESS.md` before the task is considered complete.**

This workflow is a project rule for contributors and Claude Code sessions. The documentation itself does not replace tests, review, or version-control history.

---

## A. Project overview

### Objective

SIH26171 is a privacy-first browser-agent project whose problem statement is:

> **On-device Visual Perception for Lightweight Browser Agents**

The core objective is to give a lightweight browser agent a structured understanding of the current webpage while keeping perception and sensitive-data handling local to the browser whenever possible. The eventual system should be able to perceive a page, identify relevant controls, protect sensitive information, ground a task to page elements, act through the browser, and verify the result.

### Why browser agents need perception

A browser agent cannot reliably act from a user instruction alone. It needs to know what is currently rendered, which controls are interactive, how controls are labelled, where they are located, what state they are in, and how page structure changes after an action. Perception supplies the page state used by task understanding, grounding, planning, execution, and verification.

### Why local/on-device perception matters

A traditional browser-agent design may send raw DOM content, text, screenshots, form metadata, or other page state to a remote model or server. That can expose more information than the task requires. SIH26171 instead intends to perform page perception and privacy processing locally first, establish a privacy boundary, and expose only the minimum sanitized state needed by later reasoning components.

### Privacy-first principle

The system should minimize sensitive-data collection and disclosure by construction:

- Perception should collect only fields needed for grounding and state understanding.
- Raw user-entered values should not be included in the general page representation.
- Passwords receive stricter handling than ordinary page text.
- An agent should not receive raw PII merely because it is present in the DOM or screenshot.
- Missing personal information must not be guessed; the user explicitly configures or provides profile data.
- Local execution should resolve protected values at the last responsible moment.

The current repository demonstrates the beginning of this boundary through DOM extraction that excludes input, password, hidden-input, and textarea values. The complete privacy engine and local profile mechanism are planned, not implemented.

---

## B. Core differentiator

The intended differentiator is:

> **A browser agent that performs webpage perception locally and establishes a privacy boundary before information is exposed to an AI model or server.**

The intended high-level flow is:

```text
USER TASK
    ↓
TASK UNDERSTANDING
    ↓
BROWSER
    ├── DOM PERCEPTION
    └── SCREENSHOT / VISUAL PERCEPTION
            ↓
    UNIFIED PAGE REPRESENTATION
            ↓
    LOCAL PRIVACY ENGINE
            ↓
    SANITIZED PAGE STATE
            ↓
    TASK ↔ ELEMENT GROUNDING
            ↓
    PLANNER
            ↓
    EXECUTOR
            ↓
    BROWSER
            ↓
    VERIFICATION
       /       \
   SUCCESS    FAILURE
                ↓
          RE-PERCEIVE
```

This is the target workflow. Only the extension foundation, PageRepresentation contract, and DOM perception portion currently exist.

### Stage responsibilities

1. **User task** — The user expresses an intended outcome, such as finding information or completing a form.
2. **Task understanding** — A future task-understanding component will interpret the instruction, constraints, and desired outcome. No agent or task-understanding implementation exists yet.
3. **Browser** — The browser is the environment being observed and, later, acted upon.
4. **DOM perception** — The current implementation extracts semantic and structural information from the page DOM. It is useful for roles, names, text, state, relationships, and precise element grounding.
5. **Screenshot / visual perception** — A planned component will capture and interpret visual information that DOM inspection cannot fully describe, such as visual grouping, layout, canvas content, and rendered appearance.
6. **Unified page representation** — DOM and visual observations will eventually be combined into one versioned representation. The current `PageRepresentation` is the DOM-side contract and already includes provenance so future sources can be distinguished or combined.
7. **Local privacy engine** — A planned local component will detect, classify, and protect PII and other sensitive content before it crosses the privacy boundary.
8. **Sanitized page state** — Only the minimum information needed for reasoning and grounding should leave the local perception/privacy boundary.
9. **Task ↔ element grounding** — A planned component will map task language to stable page-element identifiers and supported actions.
10. **Planner** — A future planner/agent will choose the next observation or browser action.
11. **Executor** — A future local browser executor will perform approved actions against grounded elements. It must be able to resolve protected local values without exposing them unnecessarily to the model.
12. **Verification** — A future verifier will check whether the requested outcome occurred. Failure should trigger a fresh observation rather than blind repetition.
13. **Re-perceive** — The loop is event-driven: after a meaningful page change or action, observe again and use the new state.

---

## C. Current implemented architecture

### Repository structure

The repository currently contains the following top-level areas:

| Path | Current status | Source of truth |
|---|---|---|
| `extension/` | Implemented Chrome/Brave Manifest V3 extension | `extension/manifest.json`, `extension/src/` |
| `extension/src/background/` | Implemented service worker | `service-worker.ts` |
| `extension/src/content/` | Implemented content script and DOM perception | `content-script.ts`, `domPerception.ts` |
| `extension/src/popup/` | Implemented popup UI and inspection request | `popup.ts`, `popup.html` |
| `extension/src/shared/` | Implemented messaging utilities and shared contracts | `messaging.ts`, `types.ts` |
| `extension/dist/` | Generated build output for loading the extension | `scripts/build.mjs` |
| `privacy-engine/` | Scaffold and README only; no functionality | `privacy-engine/README.md`, empty `src/index.ts` |
| `vision/` | Directory scaffold only; no visual implementation | `vision/src/` |
| `agent/` | Directory scaffold only; no agent implementation | `agent/src/` |
| `backend/` | Directory scaffold only; no backend implementation | `backend/src/` |
| `evaluation/` | Directory scaffold only; no evaluation implementation | `evaluation/src/` |
| `docs/` | Architecture and design documentation | This document and related docs |

The existing lowercase `docs/architecture.md` path is the same filesystem path as this canonical `docs/ARCHITECTURE.md` on Windows; this document is the maintained architecture document.

### Extension manifest and build

`extension/manifest.json` defines a Manifest V3 extension with:

- An ES-module background service worker at `background/service-worker.js`.
- A content script at `content/content-script.js`, matched to `<all_urls>` and run at `document_idle`.
- A popup at `popup/popup.html`.
- `activeTab` and `scripting` permissions plus `<all_urls>` host permissions.
- Placeholder icon files generated by the build script.

The root `package.json` delegates typechecking, testing, and building to the extension workspace. The extension uses TypeScript, ES2022 output, `@types/chrome`, esbuild, Vitest, and happy-dom. `extension/scripts/build.mjs` cleans `extension/dist`, compiles TypeScript, bundles the content script, and copies the manifest, popup assets, and icons.

### Current runtime message flow

The implemented runtime path is:

```text
Popup
  → chrome.runtime.sendMessage(inspect-page-request)
Background service worker
  → chrome.tabs.query({ active: true, currentWindow: true })
  → chrome.tabs.sendMessage(activeTab.id, inspect-page-request)
Content script
  → DOM perception
  → ExtensionResponse<PageRepresentation>
Background
  → Popup
```

`extension/src/shared/messaging.ts` supplies:

- `generateMessageId()` for request correlation IDs.
- `sendToBackground()` for popup-to-background messages.
- `sendToTab()` for background-to-content-script messages.
- `MessageRouter` for registering and routing message handlers.

The background service worker currently handles `INSPECT_PAGE_REQUEST`, obtains the active tab, forwards the request, and returns the response. It also registers install and startup listeners.

The content script registers the same request type, calls `extractPageRepresentationFromDom()`, and returns either a successful representation or an error response. The popup displays the page title, formatted URL, heading count, and inspection time; it does not yet expose a general-purpose agent UI.

### Current shared representation contract

`extension/src/shared/types.ts` defines schema version `1.0` and the following structures:

- `PageMetadata`: optional document title and URL.
- `Viewport`: width and height in CSS pixels.
- `ElementBounds`: viewport-coordinate x/y/width/height.
- `ElementRole`: common native and supported ARIA roles.
- `ElementState`: visibility, enabled/disabled, focus, selected, checked, and expanded state.
- `PageElement`: ID, tag name, role, normalized visible text, accessible name, placeholder, input type, bounds, state, interactive flag, selected attributes, parent/child IDs, and provenance.
- `PageRepresentation`: schema version, metadata, viewport, and an ordered array of elements.

A small `PageSnapshot` type also remains in the shared file as an earlier basic title/URL/heading-count contract. The current inspection response is the richer `PageRepresentation`.

### Current DOM perception

`extension/src/content/domPerception.ts` currently:

- Selects buttons, links, inputs, textareas, selects/options, labels, headings, images, forms, navigation elements, ARIA-role elements, and tabindex elements.
- Uses document order to assign deterministic IDs (`elem-1`, `elem-2`, and so on) for each representation.
- Normalizes whitespace in text and selected attributes.
- Extracts native and supported ARIA semantics.
- Computes accessible names from `aria-label`, `aria-labelledby`, associated labels, image alt text, and appropriate visible text.
- Uses `getBoundingClientRect()` for bounds and the production visibility check.
- Handles CSS visibility, hidden ancestors, zero-size elements, hidden inputs, disabled controls, disabled fieldsets, focus, checked state, selected options, and `aria-expanded`.
- Represents direct parent/child relationships using IDs rather than nested element objects.
- Sets `provenance` to `dom`.
- Copies only a curated set of grounding/state attributes and deliberately excludes values, passwords, checked/selected values, and arbitrary HTML attributes.
- Excludes user-entered input and textarea text even when those controls are descendants of a represented container such as a form.

### Current verification evidence

The current DOM implementation has a Vitest suite using happy-dom and mocked layout measurements. The tests cover metadata, viewport, controls, headings, normalized text, bounds, interactivity, CSS and zero-size visibility, disabled state including fieldsets, select/option state, ARIA names and states, relationships, deterministic IDs, and privacy exclusions.

The latest verified results are:

- `npm run typecheck` — passed.
- `npm test` — 24 tests passed across 3 test files.
- `npm run build` — passed and refreshed `extension/dist`.
- Brave validation — the popup successfully inspected a local page and a synthetic form page; the representation excluded synthetic input/password/textarea values. An external `https://example.com/` check was attempted but DNS was unavailable in the validation environment.

### Explicitly not implemented

The repository does **not** currently implement:

- Screenshot capture or visual perception.
- OCR or a vision model.
- A privacy/PII detection or redaction engine.
- A local profile or vault.
- An AI/LLM agent, task understanding, planner, or grounding model.
- Browser action execution or form autofill.
- Verification/recovery loops.
- Voice input/output.
- A backend, cloud service, database, authentication, or continuous model retraining.
- An evaluation harness or benchmark metrics.

These are planned phases, not current capabilities.

---

## D. Target architecture

The following components describe the intended final system. Each item is explicitly marked as current or planned so future work does not confuse the roadmap with the repository.

1. **Browser Extension — CURRENT foundation / PLANNED expansion**  
   The current extension is the runtime container. It will eventually coordinate local perception, privacy processing, grounding, execution, and verification.
2. **DOM Perception — CURRENT**  
   The extension can extract a DOM-based `PageRepresentation`. Phase 1C will improve quality and unification; this is not started yet.
3. **Visual Perception — PLANNED / NOT YET FINALIZED**  
   A future screenshot and visual-analysis component will complement DOM perception.
4. **Unified Page Representation — CURRENT contract / PLANNED unification**  
   Schema version `1.0` and DOM provenance exist. Combining DOM and visual observations is planned.
5. **Local Privacy Engine — PLANNED / NOT YET IMPLEMENTED**  
   The privacy-engine directory is scaffolded, but its README explicitly says there is no functionality yet.
6. **Task ↔ Element Grounding — PLANNED**  
   Future grounding will map task intent to representation IDs and permitted operations.
7. **Planner / Agent — PLANNED**  
   No model, agent loop, task understanding, or planner has been selected or implemented.
8. **Browser Executor — PLANNED**  
   Future local execution will apply grounded actions and resolve protected local values.
9. **Verification / Recovery — PLANNED**  
   Future verification will determine success and trigger re-perception after failure or meaningful page changes.
10. **Optional Voice Interface — PLANNED / NOT YET FINALIZED**  
    No voice technology has been selected.
11. **Evaluation / Benchmarking — PLANNED**  
    The evaluation directory is a scaffold; benchmark tasks, metrics, and performance targets are not finalized.

---

## E. Page perception

Page perception should combine complementary evidence rather than treat DOM and vision as competing approaches.

### DOM information

DOM perception is best suited to information that is explicit in the document or accessibility tree:

- Structure and hierarchy.
- Native and ARIA semantic roles.
- Accessible names and associated labels.
- Normalized visible text.
- Element bounds and viewport coordinates.
- Interaction state such as disabled, checked, selected, focused, and expanded.
- Parent/child and other grounding relationships.
- Stable IDs within one representation.

### Visual information

Visual perception is planned for information that is only apparent after rendering:

- Screenshot appearance and layout relationships.
- Visual grouping, alignment, and spatial context.
- Canvas or image content not represented by useful DOM semantics.
- Cases where the DOM is incomplete, misleading, or inaccessible.

The unified representation should preserve provenance (`dom`, `vision`, or `both`) and reconcile observations without allowing visual extraction to bypass the privacy boundary.

---

## F. Privacy architecture

### Privacy boundary

The intended privacy boundary is local to the browser. The AI agent should not need to receive raw user PII in order to select an action.

For example, form filling should conceptually use an indirect value source:

```json
{
  "action": "fill",
  "target": "field-01",
  "valueSource": "profile.firstName"
}
```

The intended execution flow is:

```text
LOCAL PROFILE
      ↓
LOCAL EXECUTOR
      ↓
WEBPAGE
```

It must **not** become:

```text
LOCAL PROFILE
      ↓
LLM / SERVER
      ↓
WEBPAGE
```

### Required privacy behaviors

- **Raw PII protection:** Raw values should be detected and protected locally before page state is exposed to a model or server.
- **Passwords:** Password fields and password values require stricter handling. They should not be sent to an agent or server and should only be resolved locally when explicitly authorized.
- **User-provided profile data:** Profile information is explicitly configured by the user. The system must not infer or invent missing personal information.
- **Missing information:** If a required profile value is unavailable, the system should stop or request user input rather than guess.
- **Local resolution:** The executor, not the model, should resolve `profile.*` references from a local profile or vault and write the result into the page.
- **Sanitization:** Page representations should contain only the minimum information needed for the current task and should preserve provenance and redaction decisions where appropriate.
- **No unnecessary exposure:** Raw DOM, screenshots, values, and credentials should not be forwarded simply because they are available locally.

The current code implements only the first narrow step: DOM extraction excludes user-entered input, password, hidden-input, and textarea values. A local profile, privacy detector, redaction engine, and executor do not yet exist.

---

## G. Development roadmap

### Phase 0 — Architecture / Repository / Extension Foundation

Establish repository structure, documentation, build tooling, MV3 extension packaging, popup, background service worker, content script, and shared messaging/types.

### Phase 1 — Browser Perception

- **1A — PageRepresentation schema:** Define the versioned common representation for metadata, viewport, elements, semantics, state, bounds, relationships, and provenance. **Current: complete.**
- **1B — DOM perception:** Extract the current page into the representation with deterministic IDs, visibility/state, accessible names, bounds, relationships, and privacy exclusions. **Current: complete.**
- **1C — DOM perception quality/unification:** Improve quality, edge-case coverage, and the unification boundary while preserving privacy and the verified contract. **Next; not started.**

### Phase 2 — Visual Perception

Add local screenshot/visual perception and integrate visual observations with the representation. Technology and model choices are not finalized.

### Phase 3 — Local PII Detection / Privacy Engine

Detect PII and sensitive content locally across DOM and future visual observations. The privacy-engine scaffold currently has no functionality.

### Phase 4 — Local Redaction / Privacy Boundary

Define and enforce sanitization, redaction, protected-value references, and the local boundary before information is exposed to an AI model or server.

### Phase 5 — AI Agent / Task Understanding / Grounding

Add task understanding, grounding, and planning only after the perception and privacy contracts are sufficiently verified. Model/provider choices are not finalized.

### Phase 6 — Browser Executor

Implement safe, local browser actions against grounded elements, including protected local value resolution. Form autofill is not implemented now.

### Phase 7 — Full SEE → THINK → ACT Agent Loop

Connect event-driven perception, task reasoning, planning, execution, and verification/recovery into a complete loop.

### Phase 8 — Voice Interface

Optionally add voice input/output after the core browser loop is stable. Technology is not finalized.

### Phase 9 — Evaluation / Benchmarking / Performance

Define benchmark tasks, success criteria, privacy checks, latency, resource use, robustness, and reproducible performance measurements. No performance numbers are claimed yet.

### Phase 10 — SIH Demo / Presentation / Q&A

Prepare a reliable demo, explain the privacy boundary and differentiator, document limitations, and prepare presentation/Q&A material.

### Milestone labels

| Milestone | Meaning |
|---|---|
| **M0** | Extension works |
| **M1** | Extension understands DOM |
| **M2** | Extension understands visuals |
| **M3** | Extension detects PII |
| **M4** | Privacy boundary demonstrable |
| **M5** | Agent reasons |
| **M6** | Agent acts |
| **M7** | Agent completes tasks |
| **M8** | Performance measured |
| **M9** | Polished demo |

---

## H. Development principles

1. Work in small increments: **implement → test → verify → commit → next component**.
2. Do not build the entire system in one shot.
3. Do not train a model from scratch initially.
4. Prefer pretrained models first.
5. Fine-tune only if evaluation demonstrates that it is necessary.
6. Do not use continuous retraining.
7. Improve datasets periodically and retrain or fine-tune only when justified by evaluation.
8. Use event-driven perception: **observe → think → act → observe again**.
9. Do not continuously capture screenshots unnecessarily.
10. Do not expose raw PII to the agent unnecessarily.
11. Never guess missing personal information.
12. Require the user to explicitly provide or configure profile information.
13. Give passwords stricter handling than ordinary form data.
14. Preserve meaningful tests and production privacy behavior; do not weaken implementation merely to satisfy a test environment.
15. Keep current, planned, and blocked work visibly distinct in documentation.

---

## I. Technology and component decisions

### Known technologies in the repository

- **Runtime:** Chrome/Brave-compatible Manifest V3 extension.
- **Language:** TypeScript.
- **Compiler target/module:** ES2022 with bundler module resolution.
- **Extension APIs:** Chrome extension APIs, typed through `@types/chrome`.
- **Build:** TypeScript compilation plus esbuild bundling for the content script.
- **Testing:** Vitest with the happy-dom environment.
- **Package structure:** npm workspace with the extension as the active workspace.
- **Current DOM layout testing:** Production uses browser `getBoundingClientRect()`; happy-dom tests mock layout measurements.

### Planned / not yet finalized

The repository has not finalized technologies or models for:

- Screenshot capture and visual perception.
- OCR or visual-language analysis.
- PII detection and redaction.
- Local profile/vault storage.
- Agent model/provider, task planning, or grounding model.
- Browser execution mechanism beyond the current message path.
- Voice interface.
- Evaluation datasets and benchmark harness.
- Any backend or cloud service.

No future technology should be documented as selected until it is actually decided and implemented or recorded as an explicit architectural decision.

---

## J. Architecture status

### CURRENT

- **Phase 0 complete:** Repository, extension foundation, messaging, build/test tooling, and documentation foundation exist.
- **Phase 1A complete:** Versioned `PageRepresentation` schema exists in shared types.
- **Phase 1B complete:** DOM perception is integrated, tested, built, and manually validated on a local form page with privacy exclusions.
- **Phase 1C next:** DOM perception quality/unification is the immediate next implementation target and has not started.

### PLANNED

- Phase 1C onward, including visual perception, privacy detection/redaction, grounding, agent reasoning, execution, verification/recovery, voice, evaluation, and demo preparation.

No Phase 1C or later functionality should be implemented as part of documentation-only work.
