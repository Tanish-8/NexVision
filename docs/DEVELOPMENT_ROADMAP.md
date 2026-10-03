# NexVision — Long-Term Product Development Roadmap

**Document Version**: 2.0.0
**Status**: Canonical Product Roadmap
**Date**: October 3, 2026
**Repository**: [https://github.com/Tanish-8/NexVision](https://github.com/Tanish-8/NexVision)

---

## Roadmap Overview

This roadmap defines the engineering transition of NexVision from an SIH 2026 demonstration prototype into a production-grade, privacy-first AI browser agent.

```text
 ┌────────────────────────────────────────────────────────┐
 │ M0: Repository & Architecture Stabilization (BASELINE)  │  ◄── CURRENT STABLE BASELINE
 └──────────────────────────┬─────────────────────────────┘
                            │
 ┌──────────────────────────▼─────────────────────────────┐
 │ M1: Core Browser Agent Reliability & Recovery           │
 └──────────────────────────┬─────────────────────────────┘
                            │
 ┌──────────────────────────▼─────────────────────────────┐
 │ M2: Privacy & Security Hardening                        │
 └──────────────────────────┬─────────────────────────────┘
                            │
 ┌──────────────────────────▼─────────────────────────────┐
 │ M3: Intelligent URL-Aware Multi-Page Research           │
 └──────────────────────────┬─────────────────────────────┘
                            │
 ┌──────────────────────────▼─────────────────────────────┐
 │ M4: Multi-Model Intelligence & Provider Abstraction     │
 └──────────────────────────┬─────────────────────────────┘
                            │
 ┌──────────────────────────▼─────────────────────────────┐
 │ M5: Product Quality, UI & User Experience               │
 └──────────────────────────┬─────────────────────────────┘
                            │
 ┌──────────────────────────▼─────────────────────────────┐
 │ M6: Performance, Latency & Context Scalability          │
 └──────────────────────────┬─────────────────────────────┘
                            │
 ┌──────────────────────────▼─────────────────────────────┐
 │ M7: Release Engineering & Chrome Web Store Distribution │
 └────────────────────────────────────────────────────────┘
```

---

## Milestone M0: Repository & Architecture Stabilization (Completed Baseline)

- **Objective**: Establish a clean, reliable, fully tested codebase with zero compile errors, verified local inference, and complete technical architecture documentation.
- **Deliverables**:
  - Unified `PageRepresentation` schema (v1.0).
  - Deterministic action grounding (`click`, `type`, `focus`).
  - Local Qwen2.5-VL-3B-Instruct inference client via `llama-server` on `127.0.0.1:8080`.
  - Contextual Chat Mode with URL intelligence, information sufficiency evaluation, and bounded 1-hop research.
  - Anchor `href` parameter scrubbing and brand whitelisting in privacy engine.
  - Complete architecture, privacy, model, research, and handover documentation.
- **Dependencies**: None (completed).
- **Acceptance Criteria**:
  - All 1,119 unit and integration tests pass without failures.
  - TypeScript typechecking (`tsc --noEmit`) passes with 0 errors across workspaces.
  - Production build (`npm run build`) bundles cleanly.
- **Verification Requirements**: Verified across automated test runner and live Chromium browser.

---

## Milestone M1: Core Browser Agent Reliability & Recovery

- **Objective**: Make autonomous browser task execution bulletproof against real-world web unpredictability (dynamic SPAs, client-side routing, DOM mutations, and network delays).
- **Deliverables**:
  - **Dynamic Mutation & Settle Observer**: Replace fixed sleep timeouts with a MutationObserver-based settle detector that signals when DOM modifications and network requests have quiesced.
  - **Navigation Recovery**: Resilient handling of full page reloads, tab navigation redirects, and back/forward history transitions during multi-step tasks.
  - **Enhanced Verification Engine**: Rich postcondition assertions (element presence, text presence, URL pattern matching, attribute changes) to confirm action success before advancing task phases.
  - **Intelligent Retry & Fallback**: Automatic target re-grounding if an element moves or detaches between planning and execution.
- **Dependencies**: Milestone M0.
- **Acceptance Criteria**:
  - Task completion rate on realistic web applications (e-commerce forms, multi-step checkouts) exceeds 90% in automated benchmarks.
  - Zero unhandled IPC timeout errors during page navigation.
- **Verification Requirements**: Automated Playwright/Puppeteer end-to-end task test harness covering complex single-page apps.

---

## Milestone M2: Privacy & Security Hardening

- **Objective**: Elevate the privacy boundary to handle sophisticated real-world data leaks, strict Content Security Policies (CSP), and adversarial prompt injections.
- **Deliverables**:
  - **Visual PII Masking**: Pre-processing tab screenshots to visually blur or black out detected text bounding boxes containing credit cards, passwords, or emails before visual LLM inspection.
  - **Deep Form Isolation**: Strict isolation of payment iframes and third-party credential managers to ensure agent cannot interact with banking credentials.
  - **Advanced Prompt Injection Sanitizer**: Semantic heuristic classifier that detects adversarial instructions embedded in user-generated content (reviews, tweets, forums).
  - **CSP Strict Compliance**: Zero inline script evaluations; zero runtime code generation (`eval()`, `new Function()`).
- **Dependencies**: Milestone M1.
- **Acceptance Criteria**:
  - 100% of tested payment card numbers and credentials in visual screenshots are obscured.
  - Adversarial prompt injection benchmark achieves 0% instruction hijack rate.
- **Verification Requirements**: Security regression suite with 100+ synthetic adversarial injection test cases.

---

## Milestone M3: Intelligent URL-Aware Multi-Page Research

- **Objective**: Expand Chat Mode research capabilities from 1-hop search to deep, multi-page cross-referencing and comparison shopping.
- **Deliverables**:
  - **Multi-Hop Traversal**: Ability to inspect search results, follow top product links, extract detailed technical specifications from product pages, and return to the main flow.
  - **Background Tab Research**: Execute research queries in temporary, inactive background tabs without disrupting the user's primary browsing view.
  - **Comparative Fact Synthesis**: Automatic generation of Markdown comparison tables (specs, pricing, ratings) comparing 2–4 competing items.
  - **Cross-Domain Verification**: Optional multi-site verification (e.g. comparing prices between Amazon and Flipkart).
- **Dependencies**: Milestones M1, M2.
- **Acceptance Criteria**:
  - System can successfully answer complex queries (*"Compare the top 3 gaming laptops under ₹60,000 on this site in a table"*) with 100% verified facts.
  - No background tabs are leaked or left orphaned upon task completion.
- **Verification Requirements**: Multi-page automated research test suite validating evidence ledger accuracy against static mock sites.

---

## Milestone M4: Multi-Model Intelligence & Provider Abstraction

- **Objective**: Allow users to seamlessly choose between local on-device models, free cloud reasoning tiers, or advanced proprietary APIs while preserving privacy defaults.
- **Deliverables**:
  - **Model Provider Abstraction (`ModelProvider`)**: Unified interface decoupling background logic from specific inference backends.
  - **Local Model Manager**: In-browser health detection, model switching (Qwen2.5-VL, Gemma-2, Llama-3.2-Vision), and quantized model downloader.
  - **Optional Cloud Connectors (User Opt-In)**:
    - Google Gemini API adapter (with free-tier support).
    - OpenRouter API adapter (with open-source free model routing).
    - Tavily Search API adapter (for external web research when on restricted pages).
  - **Pre-Transmission Sanitization Guarantee**: Strict enforcement that local sanitization runs before any prompt is transmitted to user-configured cloud providers.
- **Dependencies**: Milestone M2, M3.
- **Acceptance Criteria**:
  - User can toggle between Local and Cloud providers in settings.
  - Cloud transmission requires explicit, deliberate user opt-in and API key provision.
  - Sanitization tests confirm zero raw credit cards or passwords transmitted in cloud requests.
- **Verification Requirements**: Mock API integration test suites verifying Gemini, OpenRouter, and local fallback behavior.

---

## Milestone M5: Product Quality, UI & User Experience

- **Objective**: Transform the extension popup into a beautiful, responsive, and intuitive daily browsing assistant.
- **Deliverables**:
  - **Chrome Side Panel Integration**: Support opening NexVision in the persistent Chrome Side Panel for side-by-side browsing without popup auto-closing.
  - **Conversation & Task History**: Encrypted local IndexedDB persistence for past chat sessions and task execution reports.
  - **Interactive Research Progress**: Real-time visual progress card displaying active searches, pages visited, and facts discovered.
  - **Settings & Preferences UI**: Configurable temperature, model endpoints, PII redaction sensitivity, and search hop budgets.
  - **Accessibility (a11y)**: Full keyboard navigation, ARIA live regions for screen readers, and high-contrast theme support.
- **Dependencies**: Milestones M1, M3, M4.
- **Acceptance Criteria**:
  - Side panel opens and maintains state across tab switches.
  - WCAG 2.1 AA accessibility compliance across all extension views.
- **Verification Requirements**: Interactive UI test suite and accessibility audit.

---

## Milestone M6: Performance, Latency & Context Scalability

- **Objective**: Optimize end-to-end perception, token consumption, and response latency for smooth user interaction.
- **Deliverables**:
  - **Sub-100ms DOM Perception**: Optimized tree-walker caching and bounding box memoization for instant page representation.
  - **Streaming Responses**: Server-Sent Events (SSE) streaming from `llama-server` to popup UI for real-time word-by-word token generation.
  - **Context-Window Compression**: Hierarchical semantic summarization of long pages to preserve context tokens for multi-turn conversations.
  - **WebGPU Acceleration Exploration**: Evaluate in-browser WebGPU execution via Transformers.js / ONNX Runtime Web for zero-setup local inference without external binaries.
- **Dependencies**: Milestones M1, M5.
- **Acceptance Criteria**:
  - Perception latency under 150ms on pages with >2,000 DOM elements.
  - First-token latency in Chat Mode under 800ms.
- **Verification Requirements**: Performance benchmark harness measuring CPU, memory, and frame-rate impact.

---

## Milestone M7: Release Engineering & Chrome Web Store Distribution

- **Objective**: Prepare NexVision for public release, enterprise deployment, and Chrome Web Store distribution.
- **Deliverables**:
  - **Automated CI/CD**: GitHub Actions workflow running linting, typechecking, Vitest suite, and build packaging on all pull requests.
  - **Production Packaging**: Minified, tree-shaken extension zip archives compliant with Chrome Web Store policies.
  - **Third-Party Security Audit**: Formal code audit validating zero data exfiltration and Manifest V3 compliance.
  - **User Onboarding Flow**: First-run tutorial explaining local model setup, permissions, and privacy guarantees.
  - **Documentation & User Guides**: Video walkthroughs, documentation site, and troubleshooting guides.
- **Dependencies**: All preceding milestones (M0–M6).
- **Acceptance Criteria**:
  - 100% compliant with Chrome Web Store Developer Program Policies.
  - Automated release pipeline generates signed, verified production packages.
- **Verification Requirements**: Clean security audit report and automated deployment sign-off.
