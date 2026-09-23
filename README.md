# SIH26171 — NexVision

**On-device Visual Perception for Lightweight Browser Agents**

NexVision is a privacy-first browser-agent prototype for SIH26171. Its key architectural idea is that webpage perception and sensitive-data handling happen locally before the information is provided to the local reasoning model.

## Current Status

**Prototype status: Perception → Privacy → Grounding are verified in real browser testing. Planning → Execution currently has a local-model JSON-output blocker being fixed.**

The project has progressed substantially beyond the original foundation-only README.

Current implemented areas include:

- Manifest V3 browser extension.
- DOM page perception.
- Structured `PageRepresentation`.
- Screenshot capture.
- Local Qwen2.5-VL visual perception.
- DOM fallback when vision fails.
- Local privacy/sanitization.
- Deterministic grounding.
- Local Qwen planning.
- Browser execution for `click`, `type`, and `focus`.
- Bounded three-action agent loop.
- Service-worker reliability hardening.
- ShopSphere and TaskFlow demo targets.
- Controlled offline NexMart fallback.

## Core Architecture

```text
USER TASK
    ↓
TASK / GOAL
    ↓
BROWSER PAGE
   ├── DOM PERCEPTION
   └── SCREENSHOT / VISUAL PERCEPTION
            ↓
    UNIFIED PAGE REPRESENTATION
            ↓
    LOCAL PRIVACY / SANITIZATION
            ↓
    SANITIZED PAGE STATE
            ↓
    TASK ↔ ELEMENT GROUNDING
            ↓
    LOCAL QWEN PLANNER
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

## Privacy Principle

The intended boundary is:

```text
WEBPAGE
  ↓
LOCAL PERCEPTION
  ↓
LOCAL SANITIZATION
  ↓
SANITIZED STATE
  ↓
LOCAL QWEN
```

General DOM perception does not serialize raw input values, passwords, hidden-input values, or textarea values.

Sensitive values should be resolved locally at execution time rather than passed to the reasoning model.

## Local AI

Current local model:

```text
Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf
```

Runtime:

```text
llama.cpp llama-server
http://127.0.0.1:8080
```

Validated runtime uses Vulkan acceleration on the AMD GPU with the multimodal projection path kept on CPU because full multimodal GPU offload previously caused device-loss on the tested system.

The extension does not spawn `llama-server`; start it separately.

Example validated command:

```powershell
C:\Users\madis\.cache\nexvision-runtime\bin\llama-server.exe `
  --model C:\Users\madis\.cache\nexvision-runtime\models\Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf `
  --mmproj C:\Users\madis\.cache\nexvision-runtime\models\mmproj-Qwen2.5-VL-Instruct-Q8_0.gguf `
  --no-mmproj-offload `
  -ngl 99 `
  --device Vulkan1 `
  --host 127.0.0.1 `
  --port 8080 `
  -c 4096 `
  -t 8 `
  -fa off
```

Use the actual filenames present in the local model cache if they differ.

## Supported Actions

The current planner/executor intentionally supports only:

```text
click
type
focus
```

The model does not directly control arbitrary coordinates. It selects grounded element IDs, which are validated before execution.

## Demo

### Primary: ShopSphere

Example task:

```text
Search for laptops under ₹50,000
```

### Secondary: TaskFlow

TaskFlow can be used to demonstrate that the architecture is not ecommerce-specific.

### Offline fallback

```text
extension/demo/nexvision-demo.html
```

The NexMart page provides a deterministic local fallback if an external demo becomes unreliable.

## Three-Action Demo Constraint

The current demo loop is bounded to at most three actions/iterations.

This is deliberate. It controls local inference cost, bounds worst-case latency, and prevents runaway execution.

It is not intended as the final production termination policy.

A production version could use adaptive limits based on task completion, time, token budget, confidence, and loop detection.

## Current E2E State

The latest ShopSphere run reaches:

```text
Perception   ✅
Privacy      ✅
Grounding   ✅
Planning    ❌
Execution    —
Verify       —
```

The current planning issue is local-model output parsing. The model can reach the `max_tokens: 512` limit with `finish_reason: "length"`, producing incomplete JSON before the strict parser can validate it.

The next fix is intentionally small:

1. increase planning output headroom,
2. safely handle known JSON wrappers/fences,
3. preserve strict validation,
4. test,
5. prove Planning → Execution in Brave.

## Repository Layout

```text
NexVision/
├── agent/
├── backend/
├── docs/
├── evaluation/
├── extension/
│   ├── demo/
│   └── src/
│       ├── background/
│       ├── content/
│       ├── popup/
│       └── shared/
├── privacy-engine/
└── vision/
```

The working prototype is primarily implemented under `extension/` and `vision/`. The original scaffold directories should not be interpreted as the current runtime architecture without checking the code.

## Development

Install:

```bash
npm install
```

Extension:

```bash
npm --prefix extension run test
npm --prefix extension run typecheck
npm --prefix extension run build
```

Load the generated extension:

1. Open `brave://extensions`.
2. Enable Developer mode.
3. Load unpacked.
4. Select `extension/dist`.
5. Reload the extension after a build.
6. Refresh the target webpage so the new content script is injected.

## Development Rules

Use incremental implementation:

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
```

Do not rewrite unrelated parts of the project.

Do not weaken privacy or action validation to make a test pass.

Do not claim an E2E capability is complete based only on unit tests.

## Current Limitations

NexVision is not currently:

- a production-ready general browser agent,
- an unrestricted autonomous agent,
- a system supporting arbitrary browser actions,
- a complete semantic verification/recovery system,
- an RAG system,
- a continuously retrained system,
- a proprietary fine-tuned model.

The current Verify UI is executor-success/post-action confirmation, not a full independent semantic re-perception verifier.

## Documentation

The detailed current architecture is in:

```text
docs/ARCHITECTURE.md
```

The authoritative implementation tracker is:

```text
docs/PROGRESS.md
```

These files should be kept synchronized with actual verified implementation state.
