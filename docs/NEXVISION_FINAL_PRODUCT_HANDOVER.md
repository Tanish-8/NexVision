# NexVision — Master Engineering Handover & Product Transition Guide

**Document Version**: 2.0.0
**Status**: Authoritative Master Onboarding Document
**Date**: October 3, 2026
**Repository**: [https://github.com/Tanish-8/NexVision](https://github.com/Tanish-8/NexVision)

---

## Welcome to NexVision

This document is the **single entry point** for any software engineer or AI coding agent picking up development on NexVision. It consolidates the technical architecture, current repository state, verified capabilities, test commands, development rules, and roadmap into a single authoritative guide.

---

## 1. Product Vision & Historical Context

NexVision originated as a competitive engineering prototype for the Smart India Hackathon (SIH 2026) under the title *"On-device Visual Perception for Lightweight Browser Agents"*.

As of October 2026, the project has officially **transitioned from prototype demonstration into long-term final product development**.

### The Core Problem NexVision Solves
Most modern browser assistants (such as cloud-based AI sidebars and browser extensions) send the full contents of your web browsing history, active tabs, form inputs, and sensitive page data to remote cloud AI APIs. This exposes users to credential leaks, PII harvesting, corporate espionage, and privacy violations.

### The NexVision Solution
NexVision is a **privacy-first, on-device AI browser agent**. It runs perception, sanitization, planning, research, and reasoning **100% locally on the user's machine** using `llama.cpp` and `Qwen2.5-VL-3B-Instruct` on `http://127.0.0.1:8080`. Sensitive data (credit cards, emails, phone numbers, names, and session tokens) is redacted before model reasoning.

---

## 2. Current Technical Snapshot

| Metric / Checkpoint | Actual Current State |
| :--- | :--- |
| **Git Baseline Checkpoint** | Commit `1f6da5c` (*fix: harden local inference and content script recovery*) |
| **Active Branch** | `main` (synchronized with `origin/main`) |
| **Architecture Version** | Manifest V3 (Chrome, Brave, Edge) |
| **Language & Tooling** | TypeScript 5.4, Node.js v20+, esbuild, Vitest |
| **Automated Test Coverage** | **1,119 / 1,119 tests passing (100%)** (1,049 extension + 70 vision) |
| **TypeScript Typecheck** | **0 errors** (`tsc --noEmit`) |
| **Production Build** | **Passing** (`npm run build` generates `extension/dist/`) |
| **Local Model Endpoint** | `http://127.0.0.1:8080` (OpenAI-compatible `llama-server`) |
| **Default Active Model** | `Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf` |

---

## 3. Core Architecture & Operating Modes

NexVision implements two primary operating modes:

```
                                  User Input
                                       │
                      ┌────────────────┴────────────────┐
                      ▼                                 ▼
             💬 Contextual Chat Mode           🌐 Browser Task Mode
                      │                                 │
           ┌──────────┴──────────┐            ┌─────────┴─────────┐
           │   URL Intelligence  │            │ Goal Decomposer   │
           │ & Page Archetype    │            │ (TaskPlan Phases) │
           └──────────┬──────────┘            └─────────┬─────────┘
                      ▼                                 ▼
           ┌─────────────────────┐            ┌───────────────────┐
           │ Sufficiency Gate:   │            │ Autonomous Loop   │
           │ Direct vs Research  │            │ (1-5 Bounded Step)│
           └──────────┬──────────┘            └─────────┬─────────┘
                      ▼                                 ▼
           ┌─────────────────────┐            ┌───────────────────┐
           │ Bounded Site Search │            │ Action Grounding  │
           │ & Evidence Ledger   │            │ (Target Validate) │
           └──────────┬──────────┘            └─────────┬─────────┘
                      ▼                                 ▼
           ┌─────────────────────┐            ┌───────────────────┐
           │ Grounded Synthesis  │            │ DOM Execution     │
           │ with Untrusted Data │            │ (Synthetic Events)│
           └─────────────────────┘            └─────────┬─────────┘
                                                        ▼
                                              ┌───────────────────┐
                                              │ Postcondition     │
                                              │ Verification      │
                                              └───────────────────┘
```

### Key Modules:
- **`extension/src/background/service-worker.ts`**: Central router, tab lifecycle manager, and content-script recovery coordinator.
- **`extension/src/content/domPerception.ts`**: Pure DOM extractor harvesting viewport, bounding boxes, roles, canonical URLs, meta descriptions, and schema.org JSON-LD `Product` data.
- **`extension/src/shared/urlIntelligence.ts`**: Pure deterministic URL parser, eTLD+1 domain extractor, and page archetype classifier (`home`, `search_results`, `product`, `article`, etc.).
- **`extension/src/background/chatResearcher.ts`**: Intent evaluator, information sufficiency gate, bounded research loop coordinator, and evidence ledger accumulator.
- **`extension/src/privacy/sanitizer.ts` & `detector.ts`**: PII detector, Luhn credit card verifier, URL/anchor `href` parameter scrubber, and brand whitelisting dictionary.
- **`extension/src/shared/grounding.ts` & `actions.ts`**: Pure semantic action grounding and `IntendedAction` contract validation.
- **`extension/src/content/domExecutor.ts`**: Synthetic DOM event dispatcher (`click`, `type`, `focus`) supporting React/Vue synthetic events and form submissions.
- **`extension/src/background/localAgent.ts`**: Local `llama-server` HTTP client with candidate compaction and HTTP 400 context overflow auto-recovery.

---

## 4. Development & Testing Commands

All commands run from the repository root:

```bash
# Install workspace dependencies
npm install

# Run complete automated test suite (1,119 tests across extension and vision)
npm test

# Run TypeScript typecheck across all workspaces (must exit 0)
npm run typecheck

# Run linter
npm run lint

# Build extension production bundle (outputs to extension/dist/)
npm run build
```

### Running Local Inference (`llama-server`)
Download `Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf` and its multimodal projector:
```powershell
& "llama-server.exe" `
  --model "models/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf" `
  --mmproj "models/Qwen2.5-VL-3B-Instruct-mmproj.gguf" `
  --port 8080 `
  --ctx-size 8192 `
  --n-gpu-layers 33
```
*Note: Language layers run on GPU via Vulkan; multimodal projector is kept on CPU for stability.*

### Loading the Extension in Chromium Browsers
1. Navigate to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `extension/` (or `extension/dist/`).

---

## 5. Canonical Documentation Index

Before modifying any subsystem, read its canonical reference:

1. [**Architecture Specification (`docs/ARCHITECTURE.md`)**](ARCHITECTURE.md):
   Complete system architecture, component lifecycles, and sequence diagrams.
2. [**Privacy & Security Architecture (`docs/PRIVACY_AND_SECURITY.md`)**](PRIVACY_AND_SECURITY.md):
   PII detection, Luhn card checks, anchor `href` scrubbing, threat models, and injection defenses.
3. [**AI Model Architecture (`docs/AI_MODEL_ARCHITECTURE.md`)**](AI_MODEL_ARCHITECTURE.md):
   Local Qwen2.5-VL runtime, prompt construction, context overflow recovery, and proposed multi-model transition.
4. [**URL Intelligence & Research (`docs/URL_INTELLIGENCE_AND_RESEARCH.md`)**](URL_INTELLIGENCE_AND_RESEARCH.md):
   Page classification, sufficiency evaluation, bounded research loops, and evidence extraction.
5. [**Development Roadmap (`docs/DEVELOPMENT_ROADMAP.md`)**](DEVELOPMENT_ROADMAP.md):
   Long-term product milestones M0 through M7.
6. [**Project Status & ADRs (`docs/PROJECT_STATUS.md`)**](PROJECT_STATUS.md):
   Live checkpoint, verified capabilities, known risks, and architectural decisions.

---

## 6. Critical Engineering Invariants & Coding Rules

Future AI agents and human contributors **must strictly abide** by these rules:

1. **Zero Cloud AI Leakage**: Never send page contents, URLs, prompts, or user queries to remote AI APIs. Local inference on `127.0.0.1:8080` is the default foundation.
2. **Pre-LLM Sanitization**: Any data exposed to models (local or future opt-in cloud) must pass through `sanitizer.ts`.
3. **No Website-Specific Hacks**: Never write domain-specific conditional branches (e.g. `if (url.includes('amazon'))`) in core extension logic. Use generalizable semantic selectors, ARIA roles, and schema.org standards.
4. **Deterministic Action Grounding**: Never execute raw pixel coordinates or ungrounded clicks. Every action must target a verified DOM element via `validateIntendedAction` and `executor.ts`.
5. **No Hallucinated Specifications**: Chat research responses must strictly cite verified facts from the evidence ledger and state unverified criteria clearly.
6. **Bounded Research Loops**: Autonomous research in Chat Mode must remain strictly bounded (1 hop, max 2). Never introduce unbounded recursive crawling.
7. **Git & Commit Hygiene**: Never commit or push changes without explicit user request. Never force-push. Never stage `.env`, browser profiles, or scratch files.

---

## 7. Recommended Next Development Task

The immediate recommended engineering milestone is **Milestone M1 — Core Browser Agent Reliability & Recovery**:

1. **MutationObserver Settle Detector**: Replace arbitrary `setTimeout` delays in `domExecutor.ts` and `chatResearcher.ts` with a `MutationObserver`-based DOM settle detector.
2. **Navigation Recovery**: Enhance `demoRunner.ts` to detect full page navigations during multi-step tasks and re-attach content scripts seamlessly.
3. **Rich Postcondition Assertions**: Expand post-action verification beyond URL matching to assert specific DOM element states, text appearances, and form validation messages.
