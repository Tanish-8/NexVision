# NexVision — Authoritative Project Status & Technical Decisions Log

**Document Version**: 2.0.0
**Status**: Authoritative Live Status & Handover Reference
**Date**: October 3, 2026
**Repository**: [https://github.com/Tanish-8/NexVision](https://github.com/Tanish-8/NexVision)

---

## 1. Current Repository Checkpoint

| Attribute | Value / Status |
| :--- | :--- |
| **Active Branch** | `main` |
| **Tracking Remote** | `origin/main` (Up to date with remote) |
| **Base Commit** | `1f6da5c` — *fix: harden local inference and content script recovery* |
| **TypeScript Typecheck** | **Clean (0 errors)** across all workspaces (`tsc --noEmit`) |
| **Automated Tests** | **1,119 / 1,119 passing (100%)** (1,049 extension + 70 vision) |
| **Production Build** | **Passing (Exit code 0)** (`extension/dist/` generated cleanly) |
| **Git Diff Check** | **Clean (0 whitespace / syntax errors)** (`git diff --check`) |

---

## 2. Implemented Capabilities (Verified in Code & Tests)

The following features have been inspected, tested, and confirmed in actual source code:

### 2.1 Core Browser Extension & Runtime
- **Chrome Manifest V3 Architecture**: Background service worker with ES module imports, content scripts running at `document_idle`, and popup action interface.
- **Idempotent Content Script Reinjection**: Prevents duplicate message listener registration (`window.__nexvision_initialized__`) while providing transparent recovery when content scripts disconnect.
- **IPC Message Routing**: Type-safe message dispatch between popup, background, and content scripts with timeout handling and error mapping.

### 2.2 Perception & Privacy Engine
- **Semantic DOM Perception**: Captures viewport dimensions, interactive elements, bounding boxes, ARIA roles, and document hierarchy without serializing raw input values.
- **URL & Metadata Intelligence**: Parses protocol, hostname, registered domain (eTLD+1), canonical URLs, meta descriptions, and schema.org JSON-LD `Product` entities.
- **Page Archetype Classification**: Categorizes pages into `home`, `search_results`, `product`, `article`, `documentation`, `form`, `restricted`, `generic`.
- **Local Privacy Sanitization**: Luhn-verified credit card redaction, regex email/phone redaction, customer name scrubbing with tech brand whitelisting, and query parameter scrubbing across URLs and anchor `href`s.

### 2.3 Contextual Chat & Grounded Research Mode
- **Information Sufficiency Gate**: Evaluates query intent across 8 categories and determines whether the active DOM contains sufficient facts.
- **Bounded Site Research**: Discovers on-page search controls, executes `type` actions with `pressEnter: true`, perceives resulting search pages, and harvests structured facts.
- **Evidence Extraction Ledger**: Extracts product names, prices, ratings, and specifications into an `ExtractedFact[]` ledger.
- **Evidence-Grounded Prompting**: Wraps untrusted webpage content in strict delimiter boundaries and injects verified evidence into the local LLM prompt.

### 2.4 Autonomous Browser Task Mode
- **Task Goal Decomposition**: Decomposes user goals into structured `TaskPlan` instances with archetype classification (`form_submission`, `search_and_review`, etc.) and milestone outcomes.
- **Deterministic Action Grounding**: Validates proposed actions against live DOM elements with role compatibility, visibility checks, and spatial bounds.
- **Validated Event Execution**: Dispatches synthetic DOM events (`click`, `type`, `focus`) supporting React/Vue synthetic value trackers and native form submissions.
- **Postcondition Verification**: Re-perceives DOM state to verify that milestone conditions were achieved before advancing task phases.

### 2.5 Local AI Model Inference
- **llama.cpp Integration**: Connects via HTTP POST to `http://127.0.0.1:8080/v1/chat/completions`.
- **Candidate Compaction**: Caps interactive candidate elements to 20 to prevent context overflow.
- **HTTP 400 Mitigation**: Automatically catches context-overflow errors, truncates history, and re-attempts inference.
- **Structured JSON Normalization**: Strips markdown code blocks and repairs common schema deviations.

---

## 3. Partially Implemented Capabilities & Limitations

- **Multi-Hop Research**: Research is currently bounded to 1 hop (max 2) on the same domain. Multi-hop traversal across arbitrary link chains is planned for Milestone M3.
- **Visual PII Masking**: Visual screenshots are captured in memory and sent to the local multimodal model without pre-redaction of text rendered inside canvas or image pixels (planned for Milestone M2).
- **Background Tab Research**: Research currently executes directly in the active tab; background tab execution without visual interruption is planned for Milestone M3.
- **Single-Action Vocabulary**: Supported action vocabulary is strictly `click`, `type`, and `focus`. Complex drag-and-drop, datepickers, and canvas interactions are not supported.

---

## 4. Known Bugs, Risks & Outstanding Concerns

1. **Client-Side Routing Latency in Heavy SPAs**: Dynamic single-page applications that render search results asynchronously over 1–2 seconds can occasionally race with re-perception. A MutationObserver-based settle detector is planned for Milestone M1.
2. **Third-Party Payment iFrames**: Embedded payment gateways (`Stripe Elements`, `Razorpay iframe`) with strict origin isolation cannot be inspected by content scripts without additional elevated cross-origin permissions.
3. **Local GPU Driver Timeouts**: Running full multimodal projector layers on certain AMD Vulkan graphics drivers can cause device-loss timeouts. The current workaround maintains the multimodal projector on host CPU while language layers run on GPU.

---

## 5. Architectural Decisions Log (ADRs)

| ADR ID | Decision Title | Rationale & Trade-offs |
| :--- | :--- | :--- |
| **ADR-001** | **Strict On-Device Inference Boundary** | Preserves core product privacy guarantee. Cloud AI APIs are completely excluded from the default execution path. |
| **ADR-002** | **Deterministic Action Grounding over Raw Vision Coordinates** | Visual coordinate prediction frequently hallucinates on responsive or scrolling pages. Grounding via semantic DOM selectors and verified bounding boxes guarantees exact click accuracy. |
| **ADR-003** | **Bounded Research Budget in Chat Mode** | Unbounded crawling creates infinite loops and consumes excessive tokens. Capping research at 1 hop (max 2) ensures deterministic, fast responses. |
| **ADR-004** | **Pure TypeScript URL Intelligence Module** | Implemented `urlIntelligence.ts` with zero external dependencies to ensure sub-millisecond execution, 100% test coverage, and complete referential transparency. |
| **ADR-005** | **Anchor Href Parameter Scrubbing** | Remediation of security vulnerability where anchor links bypassed sanitization. Prevents exfiltration of authentication tokens via candidate links. |
| **ADR-006** | **Tech Brand Whitelisting in Name Redactor** | Standard capitalized word matching was incorrectly redacting computer brands (*"Acer Aspire"*, *"HP Victus"*) as person names. Whitelisting hardware terms ensures accurate e-commerce reasoning. |

---

## 6. Immediate Next Milestone

**Target**: **Milestone M1 — Core Browser Agent Reliability & Recovery**
- Implement dynamic `MutationObserver` DOM settle detection to eliminate fixed sleep timers.
- Harden page navigation recovery during autonomous task execution.
- Implement rich postcondition assertions (URL matching, text presence, attribute validation).

---

## 7. Core Development Rules & Guidelines for Future Engineering

1. **No Website-Specific Hacks**: Never write hardcoded domain checks or custom DOM hacks for specific websites (e.g. Amazon, Swiggy) into core extension logic. All selectors and heuristics must be generalizable.
2. **Preserve the Privacy-First Boundary**: Never add telemetry, analytics, or remote API calls that transmit webpage text, URLs, or prompts to external servers.
3. **Local Inference Usability**: The application must remain fully functional with `llama-server` on `127.0.0.1:8080`.
4. **No Silent Paid API Usage**: If cloud reasoning providers are added in future milestones, they must require explicit user opt-in and user-provided API keys.
5. **Deterministic Validation**: Every browser action must be grounded and validated through `validateIntendedAction` and `executor.ts`. Never execute ungrounded arbitrary clicks or strings.
6. **Evidence-Grounded Answers**: Research synthesis must cite verified facts from the evidence ledger and acknowledge missing criteria. Never hallucinate specifications.
7. **Commit & Push Control**: Never commit or push without explicit instructions from the user.
