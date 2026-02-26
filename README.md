# chrome-cdp

An agent skill that lets you control any Chromium-based browser via the Chrome DevTools Protocol. Works with Claude Code, OpenAI Codex, and any tool supporting the [Agent Skills](https://agentskills.io) spec. Give the agent a goal — "check my inbox", "top stories on Hacker News", "search for flights" — and it drives the browser to get it done.

No Playwright, no MCP, no browser automation frameworks. Raw CDP over WebSocket.

## Install

### Claude Code

From inside Claude Code:
```
/plugin marketplace add kxbnb/chrome-cdp
/plugin install chrome-cdp@chrome-cdp
```

Or from the command line:
```bash
claude plugin marketplace add kxbnb/chrome-cdp
claude plugin install chrome-cdp@chrome-cdp
```

Then install the npm dependency (one-time):
```bash
cd ~/.claude/plugins/cache/chrome-cdp/chrome-cdp/*/skills/chrome-cdp && npm install
```

### OpenAI Codex

From inside Codex:
```
/skills install https://github.com/kxbnb/chrome-cdp.git
```

Or from the command line:
```bash
codex skills install https://github.com/kxbnb/chrome-cdp.git
```

Or manually:
```bash
git clone https://github.com/kxbnb/chrome-cdp.git
cp -r chrome-cdp/skills/chrome-cdp ~/.codex/skills/chrome-cdp
cd ~/.codex/skills/chrome-cdp && npm install
```

> **Note:** Codex's sandbox blocks local networking by default. To allow CDP connections, add a rule to allow `node` access to `localhost` on the CDP port (auto-discovered at launch), or run with `--full-auto` mode.

### Other agents (Cursor, Copilot, etc.)

Drop the skill into your project:
```bash
git clone https://github.com/kxbnb/chrome-cdp.git /tmp/chrome-cdp
cp -r /tmp/chrome-cdp/skills/chrome-cdp .agents/skills/chrome-cdp
cd .agents/skills/chrome-cdp && npm install
```

Any tool supporting the [Agent Skills spec](https://agentskills.io) will auto-discover it from `.agents/skills/`.

## Usage

Just tell your agent what you want:

```
check the top stories on Hacker News
navigate to github.com and show my notifications
search google for "best restaurants near me"
```

Or describe any goal — the agent will figure out the steps.

## How it works

The agent follows a **perceive-act loop**:

1. **Plan** — break the goal into steps
2. **Act** — navigate, click, type via CDP commands
3. **Perceive** — read the DOM to see what happened
4. **Decide** — adapt, continue, or report results
5. **Repeat** — until the goal is done

DOM is read first for token efficiency. Screenshots are a fallback for visual-heavy pages.

## Sessions

Each agent invocation gets its own **session** with isolated tab tracking. On `launch`, a unique session ID is generated and a fresh Chrome tab is created for that session.

- Multiple agents can work side by side in the same Chrome instance
- Each session only sees and controls its own tabs
- Commands are passed via a JSON file, so the bash command stays the same throughout a session (only needs one user approval)

## CDP helper

The skill includes `cdp.js`, a CLI wrapper around CDP:

```bash
node cdp.js launch                  # Start browser, create session, get session ID
node cdp.js run <sessionId>         # Run command from session command file
node cdp.js navigate <url>          # Go to a URL
node cdp.js dom                     # Get compact DOM (~4000 chars)
node cdp.js dom <selector>          # Get DOM subtree
node cdp.js screenshot              # Capture screenshot
node cdp.js click <selector>        # Click an element
node cdp.js type <selector> <text>  # Type into an input
node cdp.js press <key>             # Press a key (Enter, Tab, Escape)
node cdp.js scroll <up|down>        # Scroll the page
node cdp.js eval <js>               # Run JavaScript in page context
node cdp.js tabs                    # List this session's tabs
node cdp.js tab <id>                # Switch to a session-owned tab
node cdp.js newtab [url]            # Open a new tab in this session
node cdp.js close                   # Close current tab
```

The agent workflow: `launch` prints a session ID and command file path. Write command JSON to that file, then `node cdp.js run <sessionId>`.

## Requirements

- Any Chromium-based browser: Google Chrome, Microsoft Edge, Brave, Arc, Vivaldi, Opera, or Chromium
- Node.js
- `ws` npm package (installed automatically)

Auto-detected on macOS, Linux, Windows, and WSL (finds the Windows host browser automatically). Set `CHROME_PATH` to override.

## License

MIT
