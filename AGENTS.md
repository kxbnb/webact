# Chrome CDP

This repo provides a browser automation skill using the Chrome DevTools Protocol.

## Skills

The `chrome-cdp` skill is in `.agents/skills/chrome-cdp/`. It lets you control any Chromium-based browser (Chrome, Edge, Brave, Arc, etc.) to accomplish goals like navigating pages, filling forms, clicking elements, and reading content.

## Setup

Install the npm dependency before first use:

```bash
cd .agents/skills/chrome-cdp && npm install
```

## Sandbox Note

The CDP tool connects to Chrome's debug port on `localhost:9222`. If your agent sandbox blocks local network access, you'll need to allow connections to `127.0.0.1:9222`.
