# webact

An agent skill that lets you control any Chromium-based browser via the Chrome DevTools Protocol. Works with Claude Code, OpenAI Codex, and any tool supporting the [Agent Skills](https://agentskills.io) spec. Give the agent a goal — "check my inbox", "top stories on Hacker News", "search for flights" — and it drives the browser to get it done.

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

Then install the npm dependency (one-time):
```bash
cd ~/.claude/plugins/cache/webact/webact/*/skills/webact && npm install
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
cd ~/.codex/skills/webact && npm install
```

> **Note:** Codex's sandbox blocks local networking by default. To allow CDP connections, add a rule to allow `node` access to `localhost` on the CDP port (auto-discovered at launch), or run with `--full-auto` mode.

### Other agents (Cursor, Copilot, etc.)

Drop the skill into your project:
```bash
git clone https://github.com/kxbnb/webact.git /tmp/webact
cp -r /tmp/webact/skills/webact .agents/skills/webact
cd .agents/skills/webact && npm install
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
node webact.js axtree <selector>       # Get AX tree for a specific element
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

The agent workflow: `launch` prints a session ID and command file path. Write command JSON to that file, then `node webact.js run <sessionId>`.

## Requirements

- Any Chromium-based browser: Google Chrome, Microsoft Edge, Brave, Arc, Vivaldi, Opera, or Chromium
- Node.js
- `ws` npm package (installed automatically)

Auto-detected on macOS, Linux, Windows, and WSL (finds the Windows host browser automatically). Set `CHROME_PATH` to override.

## License

MIT
