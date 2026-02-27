---
name: webact
description: Use when the user asks to interact with a website, browse the web, check a site, send a message, read content from a web page, or accomplish any goal that requires controlling a browser
---

# WebAct Browser Control

Control Chrome directly via the Chrome DevTools Protocol. No Playwright, no MCP — raw CDP through a CLI helper.

## How to Run Commands

All commands use `webact.js` from this skill's base directory. The base directory is provided when the skill loads — use it as the path prefix.

### Session Setup (once)

```bash
node <base-dir>/webact.js launch
```

This launches Chrome (or connects to an existing instance) and creates a session. All subsequent commands auto-discover the session — no session ID needed.

### Running Commands

Use direct CLI commands. Each is a single bash call:

```bash
node <base-dir>/webact.js navigate https://example.com
node <base-dir>/webact.js click button.submit
node <base-dir>/webact.js keyboard "hello world"
node <base-dir>/webact.js press Enter
node <base-dir>/webact.js dom
```

**Auto-brief:** State-changing commands (navigate, click, hover, press Enter/Tab, scroll, select, waitfor) auto-print a compact page summary showing URL, title, inputs, buttons, and links. You usually don't need a separate `dom` call. Use `dom` only when you need the full page structure or a specific selector's subtree.

### Command Reference

| Command | Example |
|---------|---------|
| `navigate <url>` | `node webact.js navigate https://example.com` |
| `back` | `node webact.js back` |
| `forward` | `node webact.js forward` |
| `reload` | `node webact.js reload` |
| `dom [selector] [--full]` | `node webact.js dom` or `node webact.js dom .results` |
| `axtree [selector]` | `node webact.js axtree` or `node webact.js axtree form` |
| `screenshot` | `node webact.js screenshot` |
| `pdf [path]` | `node webact.js pdf` or `node webact.js pdf /tmp/page.pdf` |
| `click <selector>` | `node webact.js click button.submit` |
| `doubleclick <selector>` | `node webact.js doubleclick td.cell` |
| `rightclick <selector>` | `node webact.js rightclick .context-target` |
| `hover <selector>` | `node webact.js hover .menu-trigger` |
| `focus <selector>` | `node webact.js focus input[name=q]` |
| `clear <selector>` | `node webact.js clear input[name=q]` |
| `type <selector> <text>` | `node webact.js type input[name=q] search query` |
| `keyboard <text>` | `node webact.js keyboard hello world` |
| `select <selector> <value>` | `node webact.js select select#country US` |
| `upload <selector> <file>` | `node webact.js upload input[type=file] /tmp/photo.png` |
| `drag <from> <to>` | `node webact.js drag .card .dropzone` |
| `dialog <accept\|dismiss> [text]` | `node webact.js dialog accept` |
| `waitfor <selector> [ms]` | `node webact.js waitfor .dropdown 5000` |
| `waitfornav [ms]` | `node webact.js waitfornav` |
| `press <key\|combo>` | `node webact.js press Enter` or `node webact.js press Ctrl+A` |
| `scroll <target> [px]` | `node webact.js scroll down 500` or `node webact.js scroll top` |
| `eval <js>` | `node webact.js eval document.title` |
| `cookies [get\|set\|clear\|delete]` | `node webact.js cookies` or `node webact.js cookies set name val` |
| `console [show\|errors\|listen]` | `node webact.js console` or `node webact.js console errors` |
| `block <pattern>` | `node webact.js block images css` or `node webact.js block off` |
| `viewport <w> <h>` | `node webact.js viewport mobile` or `node webact.js viewport 1024 768` |
| `frames` | `node webact.js frames` |
| `frame <id\|selector>` | `node webact.js frame main` or `node webact.js frame iframe#embed` |
| `download [path\|list]` | `node webact.js download path /tmp/dl` or `node webact.js download list` |
| `tabs` | `node webact.js tabs` |
| `tab <id>` | `node webact.js tab ABC123` |
| `newtab [url]` | `node webact.js newtab https://example.com` |
| `close` | `node webact.js close` |

**`type` vs `keyboard`:** Use `type` to focus a specific input and fill it. Use `keyboard` to type at the current caret position — essential for rich text editors (Slack, Google Docs, Notion) where `type`'s focus call resets the cursor.

**`click` behavior:** Waits up to 5s for the element, scrolls it into view, then clicks. No manual waits needed for dynamic elements.

**`dialog` behavior:** Sets a one-shot auto-handler. Run BEFORE the action that triggers the dialog.

**`axtree` vs `dom`:** The accessibility tree shows semantic roles (button, link, heading, textbox) and accessible names — better for understanding page structure. Use `dom` when you need HTML structure/selectors; use `axtree` when you need to understand what's on the page.

**`press` combos:** Supports modifier keys: `Ctrl+A` (select all), `Ctrl+C` (copy), `Meta+V` (paste on Mac), `Shift+Enter`, etc. Modifiers: Ctrl, Alt, Shift, Meta/Cmd.

**`scroll` targets:** `up`/`down` (default 400px, or specify pixels), `top`/`bottom`, or a CSS selector to scroll an element into view.

**`block` patterns:** Block resource types (`images`, `css`, `fonts`, `media`, `scripts`) or URL substrings. Speeds up page loads. Use `block off` to disable.

**`viewport` presets:** `mobile` (375x667), `iphone` (390x844), `ipad` (820x1180), `tablet` (768x1024), `desktop` (1280x800). Or specify exact width and height.

**`frames`:** Lists all frames/iframes on the page. Use `frame <id>` to switch context, `frame main` to return to the top frame.

### Tab Isolation

Each session creates and owns its own tabs. Sessions never reuse tabs from other sessions or pre-existing tabs.

- `launch`/`connect` creates a **new blank tab** for the session
- `newtab` opens an additional tab within the session
- `tabs` only lists tabs owned by the current session
- `tab <id>` only switches to session-owned tabs
- `close` removes the tab from the session

This means two agents can work side by side in the same Chrome instance without interfering with each other.

## The Perceive-Act Loop

When given a goal, follow this loop:

1. **PLAN** — Break the goal into steps. Chain predictable sequences (click → type → press Enter) into a single command array.

2. **ACT** — Write command JSON (or array), run `node <base-dir>/webact.js run <sessionId>`. Actions auto-print a page brief.

3. **DECIDE** — Read the brief. Expected state? Continue. Login wall / CAPTCHA? Tell user. Need more detail? Use `dom`. Goal complete? Report.

4. **REPEAT** until done or blocked.

## Rules

<HARD-RULES>

1. **Read the brief after acting.** State-changing commands auto-print a page brief. Read it before deciding your next step. Use `dom` only when the brief isn't enough (e.g., you need to find a specific element's selector in a complex page).

2. **DOM before screenshot.** Always try `dom` first. Only use `screenshot` if DOM output is empty/insufficient (canvas apps, image-heavy layouts).

3. **Report actual content.** When the goal is information retrieval, extract and present the actual text from the page. Do not summarize what you think is there — show what IS there.

4. **Stop when blocked.** If you encounter a login wall, CAPTCHA, 2FA prompt, or cookie consent that blocks progress, tell the user. Do not guess credentials or attempt to bypass security.

5. **Wait for dynamic content.** After clicks that trigger page loads, use `waitfornav` or `waitfor <selector>` before reading DOM.

6. **Use CSS selectors for targeting.** When you need to click or type into a specific element, identify it from the DOM output using CSS selectors (id, class, aria-label, data-testid, or structural selectors).

</HARD-RULES>

## Getting Started

**Important:** Before first use, install dependencies: `cd <base-dir> && npm install`

```bash
# Launch Chrome and get a session ID
node <base-dir>/webact.js launch
# Output: Session: a1b2c3d4
#         Command file: /tmp/webact-command-a1b2c3d4.json  (path varies by OS)
```

If Chrome is not running, `launch` starts a new instance automatically. All subsequent commands auto-discover the session.

## Token Efficiency

The `dom` command returns a compact representation:
- Scripts, styles, SVGs, hidden elements are stripped
- Only interactive and structural tags are shown with their attributes
- Whitespace is collapsed
- Output is truncated to ~4000 chars by default

Use `dom <selector>` to scope to a specific part of the page when you know where to look. This saves significant tokens on large pages.

Use `--full` only when you need the complete DOM (rare).

## Finding Elements

Read the DOM output and identify elements by:
1. **id**: `#search-input` — most reliable
2. **data-testid**: `[data-testid="submit-btn"]`
3. **aria-label**: `[aria-label="Search"]`
4. **class**: `.nav-link`
5. **structural**: `form input[type="email"]`
6. **text-based** (via eval): use eval with `document.querySelector('button').textContent`

If a CSS selector doesn't work, use `eval` to find elements by text content:
```bash
node webact.js eval "[...document.querySelectorAll('a')].find(a => a.textContent.includes('Sign in'))?.getAttribute('href')"
```

## Common Patterns

All examples assume you've already run `node webact.js launch`.

**Navigate and read** (navigate auto-prints brief — no separate dom needed):
```bash
node webact.js navigate https://news.ycombinator.com
```

**Fill a form:**
```bash
node webact.js click input[name=q]
node webact.js type input[name=q] search query
node webact.js press Enter
```

**Rich text editors and @mentions:**
```bash
node webact.js click .ql-editor
node webact.js keyboard Hello @alice
node webact.js waitfor [data-qa='tab_complete_ui_item'] 5000
node webact.js click [data-qa='tab_complete_ui_item']
node webact.js keyboard " check this out"
```
