#!/usr/bin/env node

const WebSocket = require('ws');
const http = require('http');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- State ---
const STATE_FILE = '/tmp/cdp-state.json';

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- CDP Connection ---

function getDebugUrl() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const tabs = JSON.parse(data);
          resolve(tabs);
        } catch (e) {
          reject(new Error('Failed to parse Chrome debug info'));
        }
      });
    }).on('error', (e) => {
      reject(new Error('Cannot connect to Chrome on port 9222. Is Chrome running with --remote-debugging-port=9222?'));
    });
  });
}

async function connectToTab(tabId) {
  const tabs = await getDebugUrl();
  let tab;
  if (tabId) {
    tab = tabs.find(t => t.id === tabId);
    if (!tab) throw new Error(`Tab ${tabId} not found`);
  } else {
    // Use saved tab or first page tab
    const state = loadState();
    if (state.tabId) {
      tab = tabs.find(t => t.id === state.tabId);
    }
    if (!tab) {
      tab = tabs.find(t => t.type === 'page') || tabs[0];
    }
  }
  if (!tab || !tab.webSocketDebuggerUrl) {
    throw new Error('No debuggable tab found');
  }
  saveState({ ...loadState(), tabId: tab.id });
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

async function withCDP(tabId, fn) {
  const tab = await connectToTab(tabId);
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
    await getDebugUrl();
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
      await getDebugUrl();
      console.log(`Chrome launched (PID: ${child.pid}) on port 9222.`);
      return cmdConnect();
    } catch {}
  }
  console.error('Chrome launched but debug port not responding after 15s.');
  process.exit(1);
}

async function cmdConnect() {
  const tabs = await getDebugUrl();
  const pages = tabs.filter(t => t.type === 'page');
  console.log(`Connected. ${pages.length} tab(s):`);
  for (const t of pages) {
    console.log(`  [${t.id}] ${t.title || '(untitled)'} - ${t.url}`);
  }
  if (pages.length > 0) {
    saveState({ ...loadState(), tabId: pages[0].id });
  }
}

async function cmdNavigate(url) {
  if (!url) { console.error('Usage: cdp.js navigate <url>'); process.exit(1); }
  if (!url.startsWith('http')) url = 'https://' + url;

  await withCDP(null, async (cdp) => {
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

  await withCDP(null, async (cdp) => {
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
  await withCDP(null, async (cdp) => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const outPath = '/tmp/cdp-screenshot.png';
    fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'));
    console.log(`Screenshot saved to ${outPath}`);
  });
}

async function cmdClick(selector) {
  if (!selector) { console.error('Usage: cdp.js click <selector>'); process.exit(1); }

  await withCDP(null, async (cdp) => {
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

  await withCDP(null, async (cdp) => {
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

  await withCDP(null, async (cdp) => {
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

  await withCDP(null, async (cdp) => {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY,
    });
    console.log(`Scrolled ${direction}`);
  });
}

async function cmdEval(expression) {
  if (!expression) { console.error('Usage: cdp.js eval <js-expression>'); process.exit(1); }

  await withCDP(null, async (cdp) => {
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
  const tabs = await getDebugUrl();
  const pages = tabs.filter(t => t.type === 'page');
  const state = loadState();
  for (const t of pages) {
    const active = t.id === state.tabId ? ' *' : '';
    console.log(`[${t.id}] ${t.title || '(untitled)'} - ${t.url}${active}`);
  }
}

async function cmdTab(id) {
  if (!id) { console.error('Usage: cdp.js tab <id>'); process.exit(1); }
  const tabs = await getDebugUrl();
  const tab = tabs.find(t => t.id === id);
  if (!tab) { console.error(`Tab ${id} not found`); process.exit(1); }
  saveState({ ...loadState(), tabId: id });

  // Activate the tab
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:9222/json/activate/${id}`, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    }).on('error', reject);
  });

  console.log(`Switched to tab: ${tab.title || tab.url}`);
}

async function cmdClose() {
  const state = loadState();
  if (!state.tabId) { console.error('No active tab'); process.exit(1); }

  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:9222/json/close/${state.tabId}`, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    }).on('error', reject);
  });

  console.log(`Closed tab ${state.tabId}`);
  saveState({ ...loadState(), tabId: null });
}

// --- CLI ---

async function main() {
  const [,, command, ...args] = process.argv;

  if (!command) {
    console.log(`Usage: cdp.js <command> [args]

Commands:
  launch              Launch Chrome with remote debugging
  connect             Connect to running Chrome
  navigate <url>      Navigate to URL
  dom [selector]      Get compact DOM (--full for no truncation)
  screenshot          Capture screenshot to /tmp/cdp-screenshot.png
  click <selector>    Click an element
  type <sel> <text>   Type text into element
  press <key>         Press a key (Enter, Tab, Escape, etc.)
  scroll <up|down>    Scroll the page
  eval <js>           Evaluate JavaScript
  tabs                List open tabs
  tab <id>            Switch to tab
  close               Close current tab`);
    process.exit(0);
  }

  try {
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
      case 'close': await cmdClose(); break;
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
