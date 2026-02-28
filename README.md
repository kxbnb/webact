# webact - token-efficient browser control for AI agents

A highly token efficient agent skill that lets you control any Chromium-based browser via the Chrome DevTools Protocol. Works with Claude Code, OpenAI Codex, and any tool supporting the [Agent Skills](https://agentskills.io) spec. Give the agent a goal - "check my inbox", "top stories on Hacker News", "search for flights" - and it drives the browser to get it done.

No Playwright, no MCP, no browser automation frameworks. Raw CDP over WebSocket.

## Install

### Claude Code

From inside Claude Code:
```
/plugin marketplace add kxbnb/webact
/plugin install webact@webact
```

Or from the command line:
```bash
claude plugin marketplace add kxbnb/webact
claude plugin install webact@webact
```

### OpenAI Codex

From inside Codex:
```
/skills install https://github.com/kxbnb/webact.git
```

Or from the command line:
```bash
codex skills install https://github.com/kxbnb/webact.git
```

Or manually:
```bash
git clone https://github.com/kxbnb/webact.git
cp -r webact/skills/webact ~/.codex/skills/webact
```

> **Note:** Codex's sandbox blocks local networking by default. To allow CDP connections, add a rule to allow `node` access to `localhost` on the CDP port (auto-discovered at launch), or run with `--full-auto` mode.

### Other agents (Cursor, Copilot, etc.)

Drop the skill into your project:
```bash
git clone https://github.com/kxbnb/webact.git /tmp/webact
cp -r /tmp/webact/skills/webact .agents/skills/webact
```

Any tool supporting the [Agent Skills spec](https://agentskills.io) will auto-discover it from `.agents/skills/`.

## Usage

Just tell your agent what you want:

```
check the top stories on Hacker News
navigate to github.com and show my notifications
search google for "best restaurants near me"
```

Or describe any goal - the agent will figure out the steps.

## How it works

The agent follows a **perceive-act loop**:

1. **Plan** - break the goal into steps
2. **Act** - navigate, click, type via CDP commands
3. **Perceive** - read the DOM to see what happened
4. **Decide** - adapt, continue, or report results
5. **Repeat** - until the goal is done

DOM is read first for token efficiency. Screenshots are a fallback for visual-heavy pages.

## Sessions

Each agent invocation gets its own **session** with isolated tab tracking. On `launch`, a unique session ID is generated and a fresh Chrome tab is created for that session.

- Multiple agents can work side by side in the same Chrome instance
- Each session only sees and controls its own tabs
- Commands are passed via a JSON file, so the bash command stays the same throughout a session (only needs one user approval)

## CLI helper

The skill includes `webact.js`, a CLI wrapper around CDP:

```bash
node webact.js launch                  # Start browser, create session
node webact.js navigate <url>          # Go to a URL
node webact.js back                    # Go back in history
node webact.js forward                 # Go forward in history
node webact.js reload                  # Reload the current page
node webact.js dom                     # Get compact DOM (~4000 chars)
node webact.js dom <selector>          # Get DOM subtree
node webact.js axtree                  # Get accessibility tree (semantic roles + names)
node webact.js axtree -i               # Interactive elements with ref numbers
node webact.js axtree <selector>       # Get AX tree for a specific element
node webact.js observe                 # Show interactive elements as ready-to-use commands
node webact.js screenshot              # Capture screenshot
node webact.js pdf [path]              # Save page as PDF
node webact.js click <selector>        # Click element (waits up to 5s, scrolls into view)
node webact.js doubleclick <selector>  # Double-click an element
node webact.js rightclick <selector>   # Right-click an element (context menu)
node webact.js hover <selector>        # Hover over an element (tooltips/menus)
node webact.js focus <selector>        # Focus an element without clicking
node webact.js clear <selector>        # Clear an input field or contenteditable
node webact.js type <selector> <text>  # Type into an input (focuses first)
node webact.js keyboard <text>         # Type at current caret position (no selector)
node webact.js select <sel> <value>    # Select option(s) from a <select> dropdown
node webact.js upload <sel> <file>     # Upload file(s) to a file input
node webact.js drag <from> <to>        # Drag from one selector to another
node webact.js dialog accept|dismiss   # Handle alert/confirm/prompt dialogs
node webact.js waitfor <sel> [ms]      # Wait for element to appear (default 5s)
node webact.js waitfornav [ms]         # Wait for navigation to complete (default 10s)
node webact.js press <key>             # Press a key or combo (Enter, Ctrl+A, Meta+C)
node webact.js scroll <target> [px]    # Scroll: up, down, top, bottom, or selector
node webact.js eval <js>               # Run JavaScript in page context
node webact.js cookies                 # List cookies for current page
node webact.js cookies set <n> <v>     # Set a cookie
node webact.js cookies delete <name>   # Delete a cookie
node webact.js cookies clear           # Clear all cookies
node webact.js console                 # Show recent console output
node webact.js console errors          # Show only JS errors
node webact.js block images css        # Block resource types (images/css/fonts/media/scripts)
node webact.js block off               # Disable request blocking
node webact.js viewport mobile         # Set viewport (presets: mobile, tablet, desktop)
node webact.js viewport 1024 768       # Set viewport with exact dimensions
node webact.js frames                  # List all frames/iframes
node webact.js frame <id|sel>          # Switch to a frame
node webact.js frame main              # Return to main frame
node webact.js download path /tmp/dl   # Set download directory
node webact.js download list           # List downloaded files
node webact.js tabs                    # List this session's tabs
node webact.js tab <id>                # Switch to a session-owned tab
node webact.js newtab [url]            # Open a new tab in this session
node webact.js close                   # Close current tab
node webact.js run <sessionId>         # Run command from session command file
```

**Ref-based targeting:** After `axtree -i` or `observe`, use the ref numbers directly as selectors - `click 1`, `type 3 hello`. Cached per URL.

The agent workflow: `launch` prints a session ID and command file path. Write command JSON to that file, then `node webact.js run <sessionId>`.

## Token Stats

Each command is designed to minimize token usage while giving the agent enough context to decide its next step.

| Command | webact output | Playwright equivalent | Savings |
|---------|--------------|----------------------|---------|
| **brief** (auto) | ~200 chars | No equivalent - `page.content()` returns ~50k–500k chars of raw HTML | **~99%** |
| **dom** | ~1k–4k chars (compact, truncated) | `page.content()` ~50k–500k chars (full raw HTML) | **~95%** |
| **dom \<selector\>** | ~200–4k chars (scoped subtree) | `locator.innerHTML()` ~1k–50k chars (raw HTML subtree) | **~80%** |
| **axtree -i** | ~500–1.5k chars (flat numbered list) | `page.accessibility.snapshot()` ~10k–50k chars (full JSON tree) | **~95%** |
| **axtree** | ~2k–6k chars (semantic tree) | `page.accessibility.snapshot()` ~10k–50k chars (full JSON tree) | **~80%** |
| **observe** | ~500–1.5k chars (ready-to-use commands) | No equivalent | - |
| **screenshot** | ~100k+ (base64 PNG) | `page.screenshot()` ~100k+ (same) | same |
| **console** | 200 chars/entry (truncated) | `page.on('console')` unbounded per entry | **~60%** |
| **cookies** | 60 chars/value (truncated) | `context.cookies()` full JSON objects (~200–500 chars/cookie) | **~70%** |
| **eval** | varies | `page.evaluate()` same | same |

**Recommended flow for minimal token usage:**
1. State-changing commands auto-print the **brief** (~200 chars) - often enough to decide next step
2. Need to find a specific element? Use **axtree -i** (~500 tokens) over **dom** (~4,000 chars)
3. Use **dom \<selector\>** to scope to a subtree instead of reading the whole page
4. Reserve **screenshot** for visual-heavy pages where DOM/axtree are insufficient

## vs. agent-browser

[agent-browser](https://github.com/vercel-labs/agent-browser) is Vercel's browser automation CLI for AI agents. It wraps Playwright and adds an accessibility snapshot system with refs. Both tools aim to give LLMs browser control - here's how they compare.

|  | **webact** | **agent-browser** |
|--|-----------|------------------|
| **What it is** | Browser CLI for agents - raw CDP, single file | Browser CLI for agents - Rust CLI + Node.js daemon + Playwright |
| **Architecture** | CLI connects directly to Chrome via CDP WebSocket | Rust CLI &rarr; Unix socket &rarr; Node.js daemon &rarr; Playwright &rarr; browser |
| **Install size** | 196 KB (bundled, zero deps) | ~89 MB node_modules + 162 MB Chromium download |
| **Source** | Single file, ~2,200 lines | ~9,600 lines across dist/ + Playwright dependency |
| **Setup** | Plugin install or copy - no npm install needed | `npm install agent-browser && agent-browser install` (downloads Chromium) |
| **Uses your browser** | Yes - your Chrome, your cookies, your logins | No - launches bundled Chromium with clean state |
| **Headed mode** | Always - you see what the agent sees | Headless by default (`--headed` flag to see) |
| **Auth / logins** | Already signed in - uses your real browser session | Requires auth vault, state persistence, or login flows |
| **Skill prompt size** | ~10 KB | ~19 KB |
| **Session model** | Isolated sessions share one Chrome instance | Daemon process with named sessions |

### Token comparison (same pages, measured output)

Tested on the same pages at the same time. Chars shown; divide by ~4 for approximate tokens.

| Scenario | **webact** | **agent-browser** | Page |
|----------|-----------|------------------|------|
| **Navigate + see page** | `navigate` = 186 chars | `open` + `snapshot -i` = 7,974 chars | Hacker News |
| **Navigate + see page** | `navigate` = 756 chars | `open` + `snapshot -i` = 8,486 chars | GitHub repo |
| **Full page read** | `dom` = 4,051 chars | `snapshot` = 46,565 chars | Hacker News |
| **Full page read** | `dom` = 4,049 chars | `snapshot` = 104,890 chars | GitHub repo |
| **Interactive elements** | `axtree -i` = 5,997 chars | `snapshot -i` = 7,901 chars | Hacker News |
| **Interactive elements** | `axtree -i` = 6,019 chars | `snapshot -i` = 8,337 chars | GitHub repo |

webact's `navigate` auto-prints a brief with page summary, inputs, links, and element counts - enough to decide the next step in one call. agent-browser's `open` only prints URL and title, so the agent always needs a follow-up `snapshot` to see the page.

For full page reading, webact's `dom` is truncated to ~4k chars by default. agent-browser's `snapshot` returns the full accessibility tree (46k-105k chars). On a GitHub repo page, that's **26x** more tokens.

For interactive elements, both tools offer a flat list with refs. webact's `axtree -i` is ~25-28% smaller than agent-browser's `snapshot -i`.

**When to use webact:** You want zero-setup browser control using your actual logged-in Chrome, with minimal token overhead. One file, no downloads.

**When to use agent-browser:** You need headless Chromium, auth vaults, device emulation, network mocking, visual diffing, or iOS simulator support. You're OK with the install size and Playwright dependency.

## vs. Playwright

Playwright is a browser automation framework. WebAct is an agent skill. They solve different problems but get compared because both drive browsers.

|  | **webact** | **Playwright** |
|--|-----------|---------------|
| **What it is** | Browser CLI for agents - the LLM decides what to do at each step | Test/automation framework - you write the script |
| **Protocol** | Raw CDP over WebSocket | CDP + custom protocol layer |
| **Dependencies** | 0 (bundled) | ~200 MB (bundles its own Chromium) |
| **Source** | Single file, ~2,200 lines | ~150k+ lines across packages |
| **Uses your browser** | Yes - connects to your existing Chrome with your cookies, extensions, logins | No - launches a separate bundled browser with clean state |
| **Agent-native** | Yes - compact DOM, accessibility tree, auto-briefs, ref-based targeting, token budgets | No - returns raw page content, no token awareness |
| **Session model** | Isolated sessions share one Chrome instance; multiple agents work side by side | Each test gets its own browser context |
| **Page reading** | Compact DOM (~4k chars), axtree (~500–6k chars), auto-brief (~200 chars) | Full HTML via `page.content()`, no built-in compaction |
| **Setup** | Any Chromium browser you already have | `npm install playwright && npx playwright install` |
| **Cross-browser** | Chromium-only (Chrome, Edge, Brave, Arc, etc.) | Chromium, Firefox, WebKit |
| **Headed mode** | Always - you see what the agent sees | Headless by default |
| **Auth / logins** | Already signed in - uses your real browser session | Requires explicit auth setup (storage state, login flows) |
| **Best for** | AI agents browsing the web on your behalf | Automated testing, scraping, scripting |

**When to use webact:** You want an AI agent to browse the web using your actual browser - check your email, read a page, fill out a form, accomplish a goal. The agent perceives, decides, and acts. You stay logged in everywhere.

**When to use Playwright:** You're writing deterministic test suites, scraping at scale, or need cross-browser coverage. You control every step in code.

## Requirements

- Any Chromium-based browser: Google Chrome, Microsoft Edge, Brave, Arc, Vivaldi, Opera, or Chromium
- Node.js

Auto-detected on macOS, Linux, Windows, and WSL (finds the Windows host browser automatically). Set `CHROME_PATH` to override.

## License

MIT
