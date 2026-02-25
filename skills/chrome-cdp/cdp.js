#!/usr/bin/env node

const WebSocket = require('ws');
const http = require('http');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// --- Temp directory (cross-platform) ---
const TMP = os.tmpdir();

// --- WSL detection ---
// When running in WSL with Chrome on the Windows host, we need to:
// 1. Find Chrome at /mnt/c/... paths
// 2. Pass Windows-style paths for --user-data-dir
// 3. Connect to the host IP instead of 127.0.0.1
const IS_WSL = (() => {
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch { return false; }
})();

function getWSLHostIP() {
  // Try multiple methods to find the Windows host IP from WSL
  try {
    // Method 1: WSL_HOST_IP env (newer WSL versions)
    if (process.env.WSL_HOST_IP) return process.env.WSL_HOST_IP;
    // Method 2: /etc/resolv.conf nameserver (standard WSL2)
    const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8');
    const match = resolv.match(/nameserver\s+(\d+\.\d+\.\d+\.\d+)/);
    if (match) return match[1];
  } catch {}
  return null;
}

// CDP host: in WSL2, localhost forwarding may or may not work.
// We resolve this at connect time, not startup, so we can probe.
let CDP_HOST = '127.0.0.1';

async function resolveCDPHost() {
  if (!IS_WSL) return;
  // Try localhost first (Win11 22H2+ has localhost forwarding)
  try {
    await httpGet('http://127.0.0.1:9222/json/version');
    return; // localhost works
  } catch {}
  // Fall back to host IP
  const hostIP = getWSLHostIP();
  if (hostIP) {
    try {
      await httpGet(`http://${hostIP}:9222/json/version`);
      CDP_HOST = hostIP;
      return;
    } catch {}
  }
  // Neither worked — keep localhost, let it fail with a clear error later
}

function wslWindowsPath(linuxPath) {
  // Convert a WSL/Linux path to a Windows path for passing to Windows executables
  try {
    return execSync(`wslpath -w "${linuxPath}"`, { encoding: 'utf8' }).trim();
  } catch {
    return linuxPath;
  }
}

// --- Session state ---
// Each agent session gets its own state file: <tmpdir>/cdp-state-<sessionId>.json
// State tracks: { sessionId, activeTabId, tabs: [tabId, ...] }
let currentSessionId = null;

function sessionStateFile() {
  return path.join(TMP, `cdp-state-${currentSessionId}.json`);
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
  const data = await httpGet(`http://${CDP_HOST}:9222/json`);
  try {
    return JSON.parse(data);
  } catch (e) {
    throw new Error('Failed to parse Chrome debug info');
  }
}

async function createNewTab(url) {
  const endpoint = url
    ? `http://${CDP_HOST}:9222/json/new?${url}`
    : `http://${CDP_HOST}:9222/json/new`;
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
  // Chrome returns ws://127.0.0.1:... but in WSL2 we need the host IP
  let wsUrl = tab.webSocketDebuggerUrl;
  if (IS_WSL && CDP_HOST !== '127.0.0.1') {
    wsUrl = wsUrl.replace('127.0.0.1', CDP_HOST);
  }
  const cdp = await createCDP(wsUrl);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

// --- Commands ---

// --- Browser detection ---
// All Chromium-based browsers support CDP. Ordered by preference.

function findBrowser() {
  if (process.env.CHROME_PATH) {
    if (fs.existsSync(process.env.CHROME_PATH)) {
      return { path: process.env.CHROME_PATH, name: path.basename(process.env.CHROME_PATH) };
    }
    console.error(`CHROME_PATH set but not found: ${process.env.CHROME_PATH}`);
    process.exit(1);
  }

  const home = process.env.HOME || '';
  const platform = process.platform;

  // Each entry: [path, display name]
  const candidates = [];

  if (platform === 'darwin') {
    const macApps = [
      // /Applications and ~/Applications for each
      ['Google Chrome',         'Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Google Chrome Canary',  'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
      ['Microsoft Edge',        'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave Browser',         'Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['Arc',                   'Arc.app/Contents/MacOS/Arc'],
      ['Vivaldi',               'Vivaldi.app/Contents/MacOS/Vivaldi'],
      ['Opera',                 'Opera.app/Contents/MacOS/Opera'],
      ['Chromium',              'Chromium.app/Contents/MacOS/Chromium'],
    ];
    for (const [name, rel] of macApps) {
      candidates.push([`/Applications/${rel}`, name]);
      candidates.push([`${home}/Applications/${rel}`, name]);
    }
  } else if (platform === 'linux') {
    candidates.push(
      // Chrome
      ['/usr/bin/google-chrome-stable', 'Google Chrome'],
      ['/usr/bin/google-chrome', 'Google Chrome'],
      ['/usr/local/bin/google-chrome-stable', 'Google Chrome'],
      ['/usr/local/bin/google-chrome', 'Google Chrome'],
      // Edge
      ['/usr/bin/microsoft-edge-stable', 'Microsoft Edge'],
      ['/usr/bin/microsoft-edge', 'Microsoft Edge'],
      // Brave
      ['/usr/bin/brave-browser', 'Brave Browser'],
      ['/usr/bin/brave-browser-stable', 'Brave Browser'],
      // Vivaldi
      ['/usr/bin/vivaldi-stable', 'Vivaldi'],
      ['/usr/bin/vivaldi', 'Vivaldi'],
      // Opera
      ['/usr/bin/opera', 'Opera'],
      // Chromium
      ['/usr/bin/chromium-browser', 'Chromium'],
      ['/usr/bin/chromium', 'Chromium'],
      ['/usr/local/bin/chromium-browser', 'Chromium'],
      ['/usr/local/bin/chromium', 'Chromium'],
      ['/snap/bin/chromium', 'Chromium (snap)'],
      // Flatpak (common runtime paths)
      [`${home}/.local/share/flatpak/exports/bin/com.google.Chrome`, 'Google Chrome (flatpak)'],
      ['/var/lib/flatpak/exports/bin/com.google.Chrome', 'Google Chrome (flatpak)'],
      [`${home}/.local/share/flatpak/exports/bin/org.chromium.Chromium`, 'Chromium (flatpak)'],
      ['/var/lib/flatpak/exports/bin/org.chromium.Chromium', 'Chromium (flatpak)'],
      [`${home}/.local/share/flatpak/exports/bin/com.brave.Browser`, 'Brave Browser (flatpak)'],
      ['/var/lib/flatpak/exports/bin/com.brave.Browser', 'Brave Browser (flatpak)'],
    );
    // WSL: also check Windows host browsers via /mnt/c/
    if (IS_WSL) {
      candidates.push(
        ['/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', 'Google Chrome (Windows)'],
        ['/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'Google Chrome (Windows)'],
        ['/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe', 'Microsoft Edge (Windows)'],
        ['/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'Microsoft Edge (Windows)'],
        ['/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe', 'Brave Browser (Windows)'],
        ['/mnt/c/Program Files/Vivaldi/Application/vivaldi.exe', 'Vivaldi (Windows)'],
      );
    }
  } else if (platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, 'Google Chrome'],
      [`${pf86}\\Google\\Chrome\\Application\\chrome.exe`, 'Google Chrome'],
      [`${local}\\Google\\Chrome\\Application\\chrome.exe`, 'Google Chrome'],
      [`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`, 'Microsoft Edge'],
      [`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, 'Microsoft Edge'],
      [`${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, 'Brave Browser'],
      [`${local}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, 'Brave Browser'],
      [`${pf}\\Vivaldi\\Application\\vivaldi.exe`, 'Vivaldi'],
      [`${local}\\Vivaldi\\Application\\vivaldi.exe`, 'Vivaldi'],
    );
  }

  for (const [p, name] of candidates) {
    if (fs.existsSync(p)) {
      return { path: p, name };
    }
  }

  // Fallback: try to find a browser on PATH (Linux/macOS)
  if (platform !== 'win32') {
    const pathNames = [
      ['google-chrome-stable', 'Google Chrome'],
      ['google-chrome', 'Google Chrome'],
      ['chromium-browser', 'Chromium'],
      ['chromium', 'Chromium'],
      ['microsoft-edge-stable', 'Microsoft Edge'],
      ['brave-browser', 'Brave Browser'],
    ];
    for (const [bin, name] of pathNames) {
      try {
        const resolved = execSync(`which ${bin} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (resolved) return { path: resolved, name };
      } catch {}
    }
  }

  return null;
}

async function cmdLaunch() {
  // Resolve the right host for CDP connections (handles WSL2)
  if (IS_WSL) await resolveCDPHost();

  // Check if a CDP browser is already running on 9222
  try {
    await getDebugTabs();
    console.log('Browser already running on port 9222.');
    if (IS_WSL) console.log(`WSL: connecting to ${CDP_HOST}`);
    return cmdConnect();
  } catch {}

  const browser = findBrowser();
  if (!browser) {
    console.error('No Chromium-based browser found.');
    console.error('Install one of: Google Chrome, Microsoft Edge, Brave, Chromium, Arc, Vivaldi, Opera');
    console.error('Or set CHROME_PATH to the browser executable.');
    process.exit(1);
  }

  let userDataDir = path.join(TMP, 'cdp-chrome-profile');
  const isWindowsBrowser = IS_WSL && browser.path.startsWith('/mnt/');

  // Windows browsers need Windows-style paths
  if (isWindowsBrowser) {
    userDataDir = wslWindowsPath(userDataDir);
  }

  const spawnOpts = { stdio: 'ignore' };
  if (process.platform === 'win32') {
    spawnOpts.detached = false;
    spawnOpts.shell = true;
  } else {
    spawnOpts.detached = true;
  }

  const child = spawn(browser.path, [
    `--remote-debugging-port=9222`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], spawnOpts);
  child.unref();

  // Wait for browser to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      if (IS_WSL) await resolveCDPHost();
      await getDebugTabs();
      console.log(`${browser.name} launched (PID: ${child.pid}) on port 9222.`);
      if (IS_WSL) console.log(`WSL: connecting to ${CDP_HOST}`);
      return cmdConnect();
    } catch {}
  }
  console.error(`${browser.name} launched but debug port not responding after 15s.`);
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

  const cmdFile = path.join(TMP, `cdp-command-${currentSessionId}.json`);
  console.log(`Session: ${currentSessionId}`);
  console.log(`Command file: ${cmdFile}`);
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
    const outPath = path.join(TMP, `cdp-screenshot-${currentSessionId || 'default'}.png`);
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
  await httpGet(`http://${CDP_HOST}:9222/json/activate/${id}`);
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
  await httpGet(`http://${CDP_HOST}:9222/json/close/${tabId}`);

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
       cdp.js run <sessionId>  (reads from ${TMP}${path.sep}cdp-command-<sessionId>.json)

Commands:
  launch              Launch Chrome with remote debugging
  connect             Connect to Chrome and start a new session
  navigate <url>      Navigate to URL
  dom [selector]      Get compact DOM (--full for no truncation)
  screenshot          Capture screenshot
  click <selector>    Click an element
  type <sel> <text>   Type text into element
  press <key>         Press a key (Enter, Tab, Escape, etc.)
  scroll <up|down>    Scroll the page
  eval <js>           Evaluate JavaScript
  tabs                List this session's tabs
  tab <id>            Switch to a session-owned tab
  newtab [url]        Open a new tab in this session
  close               Close current tab
  run <sessionId>     Read command from session command file`);
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
      const cmdFile = path.join(TMP, `cdp-command-${sessionId}.json`);
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
