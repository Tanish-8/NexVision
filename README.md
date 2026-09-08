# SIH26171 — On-device Visual Perception for Lightweight Browser Agents

A privacy-first browser agent whose core differentiator is that webpage perception and
sensitive-data protection happen **locally** before any information can be exposed to an
AI/server.

> **Status:** M0 — Foundation only. No LLM, no backend, no cloud AI, no auth, no DB.

## Project purpose

Traditional browser agents ship raw page content (DOM, text, screenshots) to a remote
server. This project inverts that: perception and privacy processing run inside the
browser extension itself. Only a *sanitized* representation is ever sent anywhere.

## M0 goal

Establish the project foundation:

- Chrome extension (Manifest V3)
- Content script that can inspect the current webpage
- Message-passing path: `popup → background → content-script`
- TypeScript types/interfaces for the future page representation
- Build + test tooling

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Chrome Extension                         │
│                                                              │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────────────┐  │
│  │  Popup   │──▶│  Background  │──▶│  Content Script      │  │
│  │ (UI)     │   │ (SW)         │   │ (page inspection)    │  │
│  └──────────┘   └──────────────┘   └──────────────────────┘  │
│                          │                        │           │
│                          ▼                        ▼           │
│                   ┌──────────────┐   ┌──────────────────┐  │
│                   │ Shared types │   │ Sanitized output │  │
│                   │ & utilities  │   │ (future)         │  │
│                   └──────────────┘   └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Modules (each a separate package, stubbed for now):

| Module           | Purpose (future)                                  |
|------------------|---------------------------------------------------|
| `extension/`     | Chrome MV3 extension — the runtime container      |
| `privacy-engine/`| Local PII detection & redaction                   |
| `vision/`        | Screenshot capture & on-device visual perception  |
| `agent/`         | Agent planning & tool-use loop                    |
| `backend/`       | Server-side API (NOT yet implemented)             |
| `evaluation/`    | Test harness & metrics                            |
| `docs/`          | Design docs                                       |

## How to install / build the extension

```bash
# 1. Install dependencies
npm install

# 2. Build the extension
npm run build

# 3. Load into Chrome
#    - Open chrome://extensions
#    - Enable "Developer mode" (top-right toggle)
#    - Click "Load unpacked" and select the `extension/dist` directory
```

## How to manually test

1. Build: `npm run build`
2. Load the unpacked extension from `extension/dist` in Chrome
3. Open any webpage
4. Open the extension popup — it shows the current page title and URL
5. Open DevTools on the page → Console. You should see the content-script log:
   `"[SIH26171] content script injected"`
6. Click the popup's "Inspect page" button — it sends a message to the background
   service worker, which forwards it to the content script, which returns a minimal
   page snapshot (`title`, `url`, `heading count`). The popup displays the result.

## Development scripts

| Script        | Command                       |
|---------------|-------------------------------|
| Type-check    | `npm run typecheck`           |
| Build         | `npm run build`               |
| Lint          | `npm run lint`                |
| Test          | `npm test`                    |

## Roadmap (beyond M0)

1. DOM perception → structured page representation
2. Screenshot / vision pipeline
3. Local PII detection → redaction
4. Sanitized representation emission
5. Agent planning loop
6. Browser execution (automation)
7. Evaluation harness