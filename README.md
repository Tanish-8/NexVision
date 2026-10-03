# NexVision AI

**Privacy-First, On-Device AI Browser Agent & Contextual Intelligence**

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)]()
[![Tests](https://img.shields.io/badge/tests-1119%20passed-success)]()
[![Typecheck](https://img.shields.io/badge/typecheck-clean-brightgreen)]()
[![Manifest](https://img.shields.io/badge/manifest-v3-blue)]()
[![Local AI](https://img.shields.io/badge/inference-100%25%20local%20(127.0.0.1%3A8080)-orange)]()

NexVision is an open-source, privacy-first browser extension that enables local multimodal AI to perceive, analyze, research, and automate tasks on the web. Unlike cloud-based browser assistants, NexVision processes webpage content, runs visual perception, sanitizes sensitive data, and executes AI inference **entirely on your local machine** — zero page content, credentials, or private information ever leaves your device.

---

## Key Capabilities

NexVision provides two complementary operating modes within a unified extension interface:

### 💬 1. Contextual Chat & Grounded Research Mode
- **URL & Webpage Intelligence**: Automatically parses domain semantics (eTLD+1), page archetypes (`home`, `search_results`, `product`, `article`), meta descriptions, canonical URLs, and schema.org JSON-LD structured data.
- **Information Sufficiency Gate**: Evaluates whether the active webpage contains sufficient evidence to answer user questions or whether research is needed.
- **Bounded Site Research**: Automatically locates search inputs, formulates targeted queries, submits searches, perceives results, and gathers verified facts without leaving the site.
- **Evidence-Grounded Answers**: Synthesizes structured answers from an extracted evidence ledger, clearly distinguishing between facts verified on the page, facts discovered through research, and unverified criteria.
- **Prompt Injection Defense**: Webpage text and search results are isolated within immutable, untrusted-data boundaries.

### 🌐 2. Autonomous Browser Task Mode
- **Multimodal Page Perception**: Combines semantic DOM hierarchy inspection with local visual screenshot analysis (Qwen2.5-VL-3B).
- **Deterministic Action Grounding**: Translates AI reasoning into verified browser actions (`click`, `type`, `focus`) with spatial coordinate validation and role matching.
- **Goal Decomposition & Planning**: Breaks high-level instructions (*"Search for laptops under ₹50,000"*) into structured `TaskPlan` phases with explicit milestone outcomes.
- **Postcondition Verification**: Re-perceives the DOM after each action to verify that state transitions occurred before advancing to subsequent steps.
- **Self-Healing Execution**: Recovers from dynamic page changes, re-injects content scripts if disconnected, and detects action completion.

---

## Privacy-First Architecture

The foundational guarantee of NexVision is the **local privacy boundary**:

```
 ┌─────────────────┐
 │  Active Webpage │
 └────────┬────────┘
          │
          ▼
 ┌─────────────────────────────────────────┐
 │         Local Perception Engine         │
 │  - Content Script DOM Perception        │
 │  - Screen Capture (Active Tab Only)     │
 └────────────────┬────────────────────────┘
          │
          ▼
 ┌─────────────────────────────────────────┐
 │          Local Privacy Engine           │
 │  - Luhn-Checked Credit Card Redaction   │
 │  - Email, Phone, Name Redaction         │
 │  - URL & Anchor Href Token Scrubbing    │
 │  - Password & Secret Elimination        │
 └────────────────┬────────────────────────┘
          │
          ▼
 ┌─────────────────────────────────────────┐
 │     Sanitized Page Representation       │
 └────────────────┬────────────────────────┘
          │
          ▼
 ┌─────────────────────────────────────────┐
 │    Local Model Inference (Qwen2.5-VL)   │
 │   http://127.0.0.1:8080 (llama.cpp)     │
 │        ZERO CLOUD TRANSMISSION          │
 └─────────────────────────────────────────┘
```

1. **Zero External AI Telemetry**: NexVision makes **no** network requests to OpenAI, Anthropic, Google, or any remote AI provider. All reasoning runs on `http://127.0.0.1:8080`.
2. **Pre-LLM Sanitization**: Payment cards (Luhn-verified), email addresses, phone numbers, and customer names are stripped and replaced with deterministic redaction tokens (`[REDACTED_CARD]`, `[REDACTED_EMAIL]`) before prompt assembly.
3. **Parameter Scrubbing**: Query parameters in URLs and anchor `href`s (such as `token`, `auth`, `session_id`, `key`) are scrubbed to prevent credential leaks.
4. **No Raw Form Logging**: Form passwords and text input values are never extracted into perception representations or logged in history.

---

## Technology Stack

| Layer | Technology | Details |
| :--- | :--- | :--- |
| **Extension Platform** | Chrome Manifest V3 | Service worker background, content scripts, popup action UI |
| **Language** | TypeScript 5.4 | Strict typing, ES2022 target, ESM modules |
| **Bundling** | esbuild & tsc | Fast content script bundling and typechecking |
| **Local Inference Server** | `llama.cpp` (`llama-server`) | OpenAI-compatible endpoint on `127.0.0.1:8080` |
| **Default Model** | `Qwen2.5-VL-3B-Instruct-Q4_K_M` | Local multimodal vision-language model |
| **Testing** | Vitest & happy-dom | 1,119 automated tests (unit, integration, and E2E simulation) |
| **Styling** | Vanilla CSS | Custom responsive theme, dark mode, high-contrast pipeline cards |

---

## System Requirements

- **Operating System**: Windows 10/11, macOS (Apple Silicon / Intel), or Linux
- **Browser**: Google Chrome, Brave, Edge, or any Chromium-based browser supporting Manifest V3
- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **Local Model Hardware**:
  - **GPU**: NVIDIA (CUDA), AMD (Vulkan), or Apple Silicon (Metal) with 4GB+ VRAM recommended.
  - **CPU**: Modern multi-core CPU (AVX2 support) with 8GB+ RAM if running in CPU-only mode.

---

## Quick Start & Setup

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/Tanish-8/NexVision.git
cd NexVision
npm install
```

### 2. Start the Local Inference Server
Download the GGUF model and start `llama-server` from `llama.cpp`:

```bash
# Example for Windows with Vulkan offload
& "llama-server.exe" `
  --model "models/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf" `
  --mmproj "models/Qwen2.5-VL-3B-Instruct-mmproj.gguf" `
  --port 8080 `
  --ctx-size 8192 `
  --n-gpu-layers 33
```

Verify that the local server is online:
```bash
curl http://127.0.0.1:8080/health
# Returns: {"status":"ok"}
```

### 3. Build the Extension
```bash
# Build TypeScript and bundle content scripts
npm run build
```
This compiles TypeScript to `extension/dist/` and bundles `content-script.js`.

### 4. Load the Extension in Your Browser
1. Open Chrome/Brave and navigate to `chrome://extensions`.
2. Toggle on **Developer mode** in the upper right.
3. Click **Load unpacked**.
4. Select the `extension/` directory (or `extension/dist/`).
5. Pin **NexVision AI** to your browser toolbar.

---

## Running Automated Tests

NexVision maintains comprehensive unit and integration test coverage:

```bash
# Run all tests across both extension and vision workspaces
npm test

# Run TypeScript typecheck across all workspaces
npm run typecheck

# Run linter
npm run lint
```

**Current Verification Status**:
- **Extension Workspace**: 23 test files, 1,049 tests passing (**100%**)
- **Vision Workspace**: 3 test files, 70 tests passing (**100%**)
- **Total**: **1,119 / 1,119 tests passing**

---

## Project Structure

```text
NexVision/
├── docs/                                  # Canonical product documentation
│   ├── ARCHITECTURE.md                    # In-depth system & component architecture
│   ├── PRIVACY_AND_SECURITY.md            # Privacy boundary, threat models & safeguards
│   ├── AI_MODEL_ARCHITECTURE.md           # Model integration & proposed multi-model design
│   ├── URL_INTELLIGENCE_AND_RESEARCH.md   # URL-aware research engine specification
│   ├── DEVELOPMENT_ROADMAP.md             # Long-term milestones M0 to M7
│   ├── PROJECT_STATUS.md                  # Authoritative checkpoint & decision log
│   └── NEXVISION_FINAL_PRODUCT_HANDOVER.md# Master engineering onboarding guide
│
├── extension/                             # Chrome Manifest V3 Extension
│   ├── manifest.json                      # Extension manifest
│   ├── src/
│   │   ├── background/                    # Background service worker & coordination
│   │   │   ├── service-worker.ts          # Central message router & tab manager
│   │   │   ├── chatResearcher.ts          # Intent evaluation & bounded research loop
│   │   │   ├── chatContext.ts             # Webpage chat context & prompt construction
│   │   │   ├── localAgent.ts              # Local LLM client & plan decomposer
│   │   │   ├── demoRunner.ts              # Autonomous task loop & milestone verifier
│   │   │   ├── executor.ts                # Action execution coordinator
│   │   │   ├── orchestrator.ts            # Unified DOM + Vision perception
│   │   │   └── screenshot.ts              # Tab screenshot capture
│   │   ├── content/                       # Content scripts running in web pages
│   │   │   ├── content-script.ts          # Content script entry & idempotency guard
│   │   │   ├── domPerception.ts           # Semantic DOM, JSON-LD & metadata extractor
│   │   │   └── domExecutor.ts             # Synthetic event dispatcher (click/type/focus)
│   │   ├── popup/                         # Extension popup interface
│   │   │   ├── popup.html                 # Dual-mode UI (Chat + Task)
│   │   │   ├── popup.css                  # Responsive styles & pipeline animations
│   │   │   └── popup.ts                   # UI event handlers & status poller
│   │   ├── privacy/                       # Local privacy engine
│   │   │   ├── sanitizer.ts               # PII redaction & URL parameter scrubber
│   │   │   ├── detector.ts                # Pattern matchers & brand dictionary
│   │   │   └── luhn.ts                    # Credit card checksum validation
│   │   └── shared/                        # Shared contracts & pure utilities
│   │       ├── types.ts                   # Unified types & message protocols
│   │       ├── urlIntelligence.ts         # Deterministic URL parsing & classification
│   │       ├── actions.ts                 # Action validation & contracts
│   │       ├── grounding.ts               # Intent-to-element resolver
│   │       ├── planner.ts                 # Task archetypes & plan structures
│   │       └── messaging.ts               # Type-safe extension IPC wrapper
│   └── dist/                              # Production build output
│
└── vision/                                # Standalone Vision Perception Package
    ├── src/                               # Vision adapters & coordinate transformers
    └── tests/                             # Visual perception test suite
```

---

## Known Limitations & Boundaries

To ensure complete transparency, the following technical limitations apply to the current release:

1. **Local Model Dependency**: Requires `llama-server` running locally on `http://127.0.0.1:8080`. If the server is offline, the extension displays an offline indicator and cannot reason.
2. **Single-Action & Bounded Execution**: Browser tasks are bounded to 1–5 steps per goal. Research loops in Chat Mode are bounded to 1 hop (max 2) to prevent infinite navigation loops.
3. **Supported Action Vocabulary**: Supports `click`, `type`, and `focus`. Drag-and-drop, canvas drawing, and file uploads are not supported.
4. **Restricted Browser Pages**: Extension APIs cannot inspect or execute actions on internal browser URLs (`chrome://`, `edge://`, `about:`, `chrome-extension://`).
5. **Dynamic Single-Page Applications**: Heavy shadow DOM implementations or iframe-embedded checkout forms may require re-perception settling delays.
6. **Privacy Boundary Scope**: Sanitization operates on structured text and known regex/dictionary patterns. OCR-based extraction of text baked into image pixels is not currently redacted.

---

## Documentation Index

- 📘 [**Architecture Overview**](docs/ARCHITECTURE.md): Complete system architecture, component lifecycles, and sequence diagrams.
- 🔒 [**Privacy & Security Specification**](docs/PRIVACY_AND_SECURITY.md): Threat models, sanitization algorithms, and injection defenses.
- 🧠 [**AI Model Architecture**](docs/AI_MODEL_ARCHITECTURE.md): Local Qwen2.5-VL integration and proposed multi-model design.
- 🌐 [**URL Intelligence & Research**](docs/URL_INTELLIGENCE_AND_RESEARCH.md): Information sufficiency and bounded on-site research engine.
- 🗺️ [**Development Roadmap**](docs/DEVELOPMENT_ROADMAP.md): Detailed milestone plan from M0 to M7.
- 📊 [**Project Status**](docs/PROJECT_STATUS.md): Current checkpoint, verified capabilities, and technical decisions log.
- 🤝 [**Final Product Handover Guide**](docs/NEXVISION_FINAL_PRODUCT_HANDOVER.md): Master onboarding guide for future engineering agents.

---

## License

This project is licensed under the MIT License — see the LICENSE file for details.
