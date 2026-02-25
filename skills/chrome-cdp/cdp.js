#!/usr/bin/env node

const WebSocket = require('ws');
const http = require('http');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Session state ---
// Each agent session gets its own state file: /tmp/cdp-state-<sessionId>.json
// State tracks: { sessionId, activeTabId, tabs: [tabId, ...] }
let currentSessionId = null;

function sessionStateFile() {
  return `/tmp/cdp-state-${currentSessionId}.json`;
}

function loadSessionState() {
  if (!currentSessionId) return { tabs: [] };
  try {
    return JSON.parse(fs.readFileSync(sessionStateFile(), 'utf8'));
  } catch {
    return { sessionId: currentSessionId, activeTabId: null, tabs: [] };
  }
}

function saveSessionState(state) {
  if (!currentSessionId) return;
  fs.writeFileSync(sessionStateFile(), JSON.stringify(state, null, 2));
}

// --- CDP Connection ---

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function getDebugTabs() {
  const data = await httpGet('http://127.0.0.1:9222/json');
  try {
    return JSON.parse(data);
  } catch (e) {
    throw new Error('Failed to parse Chrome debug info');
  }
}

async function createNewTab(url) {
  const endpoint = url
    ? `http://127.0.0.1:9222/json/new?${url}`
    : 'http://127.0.0.1:9222/json/new';
  const data = await httpGet(endpoint);
  try {
    return JSON.parse(data);
  } catch (e) {
    throw new Error('Failed to create new tab');
  }
}

async function connectToTab() {
  const state = loadSessionState();
  const tabs = await getDebugTabs();

  let tab;
  if (state.activeTabId) {
    tab = tabs.find(t => t.id === state.activeTabId);
    if (!tab) {
      // Active tab gone — try another session-owned tab
      for (const ownedId of state.tabs) {
        tab = tabs.find(t => t.id === ownedId);
        if (tab) break;
      }
    }
  }

  if (!tab || !tab.webSocketDebuggerUrl) {
    throw new Error('No active tab for this session. Navigate to a URL first.');
  }

  // Update active tab
  state.activeTabId = tab.id;
  saveSessionState(state);
  return tab;
}

function createCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const pending = new Map();

    ws.on('open', () => {
      const cdp = {
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = msgId++;
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          ws.close();
        }
      };
      resolve(cdp);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(`${msg.error.message} (${msg.error.code})`));
        } else {
          resolve(msg.result);
        }
      }
    });

    ws.on('error', reject);
    ws.on('close', () => {
      for (const { reject } of pending.values()) {
        reject(new Error('WebSocket closed'));
      }
      pending.clear();
    });
  });
}

async function withCDP(fn) {
  const tab = await connectToTab();
  const cdp = await createCDP(tab.webSocketDebuggerUrl);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

// --- Commands ---

async function cmdLaunch() {
  // Check if Chrome is already running on 9222
  try {
    await getDebugTabs();
    console.log('Chrome already running on port 9222.');
    return cmdConnect();
  } catch {}

  const home = process.env.HOME || '';
  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    `${home}/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`,
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    `${home}/Applications/Chromium.app/Contents/MacOS/Chromium`,
  ];

  let chromePath;
  for (const p of chromePaths) {
    if (fs.existsSync(p)) {
      chromePath = p;
      break;
    }
  }

  if (!chromePath) {
    console.error('Chrome not found. Install Google Chrome or set CHROME_PATH.');
    process.exit(1);
  }

  if (process.env.CHROME_PATH) {
    chromePath = process.env.CHROME_PATH;
  }

  const userDataDir = '/tmp/cdp-chrome-profile';

  const child = spawn(chromePath, [
    `--remote-debugging-port=9222`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for Chrome to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      await getDebugTabs();
      console.log(`Chrome launched (PID: ${child.pid}) on port 9222.`);
      return cmdConnect();
    } catch {}
  }
  console.error('Chrome launched but debug port not responding after 15s.');
  process.exit(1);
}

async function cmdConnect() {
  // Generate a new session ID
  currentSessionId = crypto.randomBytes(4).toString('hex');

  // Create a fresh tab for this session
  const newTab = await createNewTab();
  const state = {
    sessionId: currentSessionId,
    activeTabId: newTab.id,
    tabs: [newTab.id],
  };
  saveSessionState(state);

  console.log(`Session: ${currentSessionId}`);
  console.log(`Command file: /tmp/cdp-command-${currentSessionId}.json`);
  console.log(`New tab created: [${newTab.id}] ${newTab.url}`);
}

async function cmdNavigate(url) {
  if (!url) { console.error('Usage: cdp.js navigate <url>'); process.exit(1); }
  if (!url.startsWith('http')) url = 'https://' + url;

  await withCDP(async (cdp) => {
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url });

    // Wait for load
    const start = Date.now();
    while (Date.now() - start < 15000) {
      await new Promise(r => setTimeout(r, 300));
      const result = await cdp.send('Runtime.evaluate', {
        expression: 'document.readyState'
      });
      if (result.result && result.result.value === 'complete') break;
    }

    const titleResult = await cdp.send('Runtime.evaluate', {
      expression: 'document.title'
    });
    console.log(`Navigated to: ${url}`);
    console.log(`Title: ${titleResult.result.value}`);
  });
}

async function cmdDom(selector, full) {
  const extractScript = `
    (function() {
      const SKIP_TAGS = new Set(['SCRIPT','STYLE','SVG','NOSCRIPT','LINK','META','HEAD']);
      const INTERACTIVE = new Set(['A','BUTTON','INPUT','TEXTAREA','SELECT','DETAILS','SUMMARY']);
      const KEEP_ATTRS = ['id','class','href','placeholder','aria-label','type','name','value','role','title','alt','for','action','data-testid'];
      const MAX_LEN = ${full ? 100000 : 4000};

      function isVisible(el) {
        if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (style.position !== 'fixed' && style.position !== 'sticky') return false;
        }
        return true;
      }

      function extract(node, depth) {
        if (!node) return '';
        if (node.nodeType === 3) {
          const text = node.textContent.replace(/\\s+/g, ' ').trim();
          return text ? text + ' ' : '';
        }
        if (node.nodeType !== 1) return '';
        const tag = node.tagName;
        if (SKIP_TAGS.has(tag)) return '';
        if (!isVisible(node)) return '';

        let out = '';
        const isInteractive = INTERACTIVE.has(tag);
        const attrs = [];
        for (const a of KEEP_ATTRS) {
          const v = node.getAttribute(a);
          if (v) attrs.push(a + '="' + v.substring(0, 80) + '"');
        }

        const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
        const indent = '  '.repeat(Math.min(depth, 6));

        // Only show tags that are interactive or structural
        const showTag = isInteractive || ['FORM','NAV','MAIN','HEADER','FOOTER','SECTION','ARTICLE','H1','H2','H3','H4','H5','H6','TABLE','TR','TD','TH','UL','OL','LI','LABEL','IMG','IFRAME'].includes(tag);

        if (showTag) {
          out += indent + '<' + tag.toLowerCase() + attrStr + '>';
        }

        let childOut = '';
        for (const child of node.childNodes) {
          childOut += extract(child, depth + (showTag ? 1 : 0));
        }
        out += childOut;

        if (showTag && childOut.includes('\\n')) {
          out += indent + '</' + tag.toLowerCase() + '>\\n';
        } else if (showTag) {
          out += '</' + tag.toLowerCase() + '>\\n';
        }

        return out;
      }

      const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'};
      if (!root) return 'ERROR: Element not found' + (${selector ? `' for selector: ' + ${JSON.stringify(selector)}` : "''"});
      let result = extract(root, 0);
      if (result.length > MAX_LEN) {
        result = result.substring(0, MAX_LEN) + '\\n... (truncated, use --full for complete output)';
      }
      return result;
    })()
  `;

  await withCDP(async (cdp) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: extractScript,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      console.error('DOM extraction error:', result.exceptionDetails.text);
      process.exit(1);
    }
    console.log(result.result.value);
  });
}

async function cmdScreenshot() {
  await withCDP(async (cdp) => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const outPath = `/tmp/cdp-screenshot-${currentSessionId || 'default'}.png`;
    fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'));
    console.log(`Screenshot saved to ${outPath}`);
  });
}

async function cmdClick(selector) {
  if (!selector) { console.error('Usage: cdp.js click <selector>'); process.exit(1); }

  await withCDP(async (cdp) => {
    // Find element center and click
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { error: 'Element not found: ${selector}' };
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          return { x, y, tag: el.tagName, text: (el.textContent || '').substring(0, 50).trim() };
        })()
      `,
      returnByValue: true,
    });

    const loc = result.result.value;
    if (loc.error) { console.error(loc.error); process.exit(1); }

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1
    });

    console.log(`Clicked <${loc.tag.toLowerCase()}> "${loc.text}" at (${Math.round(loc.x)}, ${Math.round(loc.y)})`);
  });
}

async function cmdType(selector, text) {
  if (!selector || !text) { console.error('Usage: cdp.js type <selector> <text>'); process.exit(1); }

  await withCDP(async (cdp) => {
    // Focus the element
    await cdp.send('Runtime.evaluate', {
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Element not found: ${selector}');
          el.focus();
          if (el.select) el.select();
        })()
      `,
    });

    // Type character by character for compatibility
    for (const char of text) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', text: char, unmodifiedText: char,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', text: char, unmodifiedText: char,
      });
    }

    console.log(`Typed "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" into ${selector}`);
  });
}

async function cmdPress(key) {
  if (!key) { console.error('Usage: cdp.js press <key>'); process.exit(1); }

  const keyMap = {
    'enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    'delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
    'arrowup': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'arrowdown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'arrowleft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'arrowright': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    'space': { key: ' ', code: 'Space', keyCode: 32 },
  };

  const mapped = keyMap[key.toLowerCase()] || { key, code: `Key${key.toUpperCase()}`, keyCode: key.charCodeAt(0) };

  await withCDP(async (cdp) => {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', ...mapped, windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', ...mapped, windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode,
    });
    console.log(`Pressed: ${key}`);
  });
}

async function cmdScroll(direction) {
  if (!direction) { console.error('Usage: cdp.js scroll <up|down>'); process.exit(1); }
  const deltaY = direction.toLowerCase() === 'up' ? -400 : 400;

  await withCDP(async (cdp) => {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY,
    });
    console.log(`Scrolled ${direction}`);
  });
}

async function cmdEval(expression) {
  if (!expression) { console.error('Usage: cdp.js eval <js-expression>'); process.exit(1); }

  await withCDP(async (cdp) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      console.error('Error:', result.exceptionDetails.text || result.exceptionDetails.exception?.description);
      process.exit(1);
    }
    const val = result.result.value;
    if (val !== undefined) {
      console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : val);
    } else {
      console.log(`(${result.result.type}: ${result.result.description || result.result.value})`);
    }
  });
}

async function cmdTabs() {
  const allTabs = await getDebugTabs();
  const state = loadSessionState();
  const ownedIds = new Set(state.tabs || []);
  const owned = allTabs.filter(t => ownedIds.has(t.id));
  if (owned.length === 0) {
    console.log('No tabs owned by this session.');
    return;
  }
  for (const t of owned) {
    const active = t.id === state.activeTabId ? ' *' : '';
    console.log(`[${t.id}] ${t.title || '(untitled)'} - ${t.url}${active}`);
  }
}

async function cmdTab(id) {
  if (!id) { console.error('Usage: cdp.js tab <id>'); process.exit(1); }
  const state = loadSessionState();
  if (!(state.tabs || []).includes(id)) {
    console.error(`Tab ${id} is not owned by this session.`);
    process.exit(1);
  }
  const allTabs = await getDebugTabs();
  const tab = allTabs.find(t => t.id === id);
  if (!tab) { console.error(`Tab ${id} not found in Chrome`); process.exit(1); }

  state.activeTabId = id;
  saveSessionState(state);

  // Activate the tab in Chrome
  await httpGet(`http://127.0.0.1:9222/json/activate/${id}`);
  console.log(`Switched to tab: ${tab.title || tab.url}`);
}

async function cmdNewTab(url) {
  const newTab = await createNewTab(url);
  const state = loadSessionState();
  state.tabs.push(newTab.id);
  state.activeTabId = newTab.id;
  saveSessionState(state);
  console.log(`New tab: [${newTab.id}] ${newTab.url}`);
}

async function cmdClose() {
  const state = loadSessionState();
  if (!state.activeTabId) { console.error('No active tab'); process.exit(1); }

  const tabId = state.activeTabId;
  await httpGet(`http://127.0.0.1:9222/json/close/${tabId}`);

  // Remove from session
  state.tabs = (state.tabs || []).filter(id => id !== tabId);
  state.activeTabId = state.tabs.length > 0 ? state.tabs[state.tabs.length - 1] : null;
  saveSessionState(state);

  console.log(`Closed tab ${tabId}`);
  if (state.activeTabId) {
    console.log(`Active tab is now: ${state.activeTabId}`);
  } else {
    console.log('No tabs remaining in this session.');
  }
}

// --- Command dispatch ---

async function dispatch(command, args) {
  switch (command) {
    case 'launch': await cmdLaunch(); break;
    case 'connect': await cmdConnect(); break;
    case 'navigate': await cmdNavigate(args.join(' ')); break;
    case 'dom': {
      const full = args.includes('--full');
      const selector = args.filter(a => a !== '--full').join(' ') || null;
      await cmdDom(selector, full);
      break;
    }
    case 'screenshot': await cmdScreenshot(); break;
    case 'click': await cmdClick(args.join(' ')); break;
    case 'type': {
      const selector = args[0];
      const text = args.slice(1).join(' ');
      await cmdType(selector, text);
      break;
    }
    case 'press': await cmdPress(args[0]); break;
    case 'scroll': await cmdScroll(args[0]); break;
    case 'eval': await cmdEval(args.join(' ')); break;
    case 'tabs': await cmdTabs(); break;
    case 'tab': await cmdTab(args[0]); break;
    case 'newtab': await cmdNewTab(args.join(' ') || undefined); break;
    case 'close': await cmdClose(); break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

// --- CLI ---

async function main() {
  const [,, command, ...args] = process.argv;

  if (!command) {
    console.log(`Usage: cdp.js <command> [args]
       cdp.js run <sessionId>  (reads from /tmp/cdp-command-<sessionId>.json)

Commands:
  launch              Launch Chrome with remote debugging
  connect             Connect to Chrome and start a new session
  navigate <url>      Navigate to URL
  dom [selector]      Get compact DOM (--full for no truncation)
  screenshot          Capture screenshot to /tmp/cdp-screenshot-<session>.png
  click <selector>    Click an element
  type <sel> <text>   Type text into element
  press <key>         Press a key (Enter, Tab, Escape, etc.)
  scroll <up|down>    Scroll the page
  eval <js>           Evaluate JavaScript
  tabs                List this session's tabs
  tab <id>            Switch to a session-owned tab
  newtab [url]        Open a new tab in this session
  close               Close current tab
  run <sessionId>     Read command from /tmp/cdp-command-<sessionId>.json`);
    process.exit(0);
  }

  try {
    if (command === 'run') {
      const sessionId = args[0];
      if (!sessionId) {
        console.error('Usage: cdp.js run <sessionId>');
        process.exit(1);
      }
      currentSessionId = sessionId;
      const cmdFile = `/tmp/cdp-command-${sessionId}.json`;
      let cmdData;
      try {
        cmdData = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
      } catch (e) {
        console.error(`Cannot read ${cmdFile}: ${e.message}`);
        process.exit(1);
      }
      const fileCmd = cmdData.command;
      const fileArgs = cmdData.args || [];
      if (!fileCmd) {
        console.error(`${cmdFile} missing "command" field`);
        process.exit(1);
      }
      await dispatch(fileCmd, fileArgs);
    } else {
      await dispatch(command, args);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
