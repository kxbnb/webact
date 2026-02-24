# chrome-cdp

A Claude Code plugin that lets you control Chrome via the Chrome DevTools Protocol. Give the agent a goal — "check my inbox", "top stories on Hacker News", "search for flights" — and it drives the browser to get it done.

No Playwright, no MCP, no browser automation frameworks. Raw CDP over WebSocket.

## Install

Add the marketplace and install the plugin:

```
/plugin marketplace add kxbnb/chrome-cdp
/plugin install chrome-cdp@chrome-cdp
```

Then install the npm dependency (one-time):

```bash
cd ~/.claude/plugins/cache/chrome-cdp/chrome-cdp/*/skills/chrome-cdp && npm install
```

## Usage

Just tell Claude what you want:

```
/chrome-cdp check the top stories on Hacker News
/chrome-cdp navigate to github.com and show my notifications
/chrome-cdp search google for "best restaurants near me"
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

## CDP helper

The plugin includes `cdp.js`, a CLI wrapper around CDP:

```bash
node cdp.js launch                  # Start Chrome with remote debugging
node cdp.js navigate <url>          # Go to a URL
node cdp.js dom                     # Get compact DOM (~4000 chars)
node cdp.js dom <selector>          # Get DOM subtree
node cdp.js screenshot              # Save screenshot to /tmp/cdp-screenshot.png
node cdp.js click <selector>        # Click an element
node cdp.js type <selector> <text>  # Type into an input
node cdp.js press <key>             # Press a key (Enter, Tab, Escape)
node cdp.js scroll <up|down>        # Scroll the page
node cdp.js eval <js>               # Run JavaScript in page context
node cdp.js tabs                    # List open tabs
node cdp.js tab <id>                # Switch tab
node cdp.js close                   # Close current tab
```

## Requirements

- Google Chrome
- Node.js
- `ws` npm package (installed automatically)

## License

MIT
