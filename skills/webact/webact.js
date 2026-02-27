#!/usr/bin/env node

const WebSocket = require('ws');
const http = require('http');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');

// --- Temp directory (cross-platform) ---
const TMP = os.tmpdir();

// --- CDP port (resolved at runtime) ---
let CDP_PORT = 9222;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

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
    await httpGet(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return; // localhost works
  } catch {}
  // Fall back to host IP
  const hostIP = getWSLHostIP();
  if (hostIP) {
    try {
      await httpGet(`http://${hostIP}:${CDP_PORT}/json/version`);
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
// Each agent session gets its own state file: <tmpdir>/webact-state-<sessionId>.json
// State tracks: { sessionId, activeTabId, tabs: [tabId, ...] }
let currentSessionId = null;

const LAST_SESSION_FILE = path.join(TMP, 'webact-last-session');

function sessionStateFile() {
  return path.join(TMP, `webact-state-${currentSessionId}.json`);
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

function httpPut(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'PUT',
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

async function getDebugTabs() {
  const data = await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json`);
  try {
    return JSON.parse(data);
  } catch (e) {
    throw new Error('Failed to parse Chrome debug info');
  }
}

async function createNewTab(url) {
  const endpoint = url
    ? `http://${CDP_HOST}:${CDP_PORT}/json/new?${url}`
    : `http://${CDP_HOST}:${CDP_PORT}/json/new`;
  const data = await httpPut(endpoint);
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
    const eventHandlers = new Map();

    ws.on('open', () => {
      const cdp = {
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = msgId++;
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(event, handler) {
          eventHandlers.set(event, handler);
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
      } else if (msg.method && eventHandlers.has(msg.method)) {
        eventHandlers.get(msg.method)(msg.params);
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

// Compact page brief: ~200 chars instead of ~4000 for full DOM
// Gives the agent enough to decide next step without a separate dom call
const PAGE_BRIEF_SCRIPT = `(function() {
  const t = document.title, u = location.href;
  const seen = new Set();
  const inputs = [], buttons = [], links = [];
  document.querySelectorAll('input:not([type=hidden]),textarea,select').forEach(el => {
    if (!el.offsetParent && getComputedStyle(el).display === 'none') return;
    if (inputs.length >= 5) return;
    const key = el.name || el.id || el.type;
    if (seen.has(key)) return;
    seen.add(key);
    const a = [el.tagName.toLowerCase()];
    if (el.name) a.push('name=' + el.name);
    if (el.type && el.type !== 'text') a.push('type=' + el.type);
    if (el.placeholder) a.push(JSON.stringify(el.placeholder.substring(0, 40)));
    inputs.push('[' + a.join(' ') + ']');
  });
  document.querySelectorAll('button,[role=button],input[type=submit]').forEach(el => {
    if (!el.offsetParent && getComputedStyle(el).display === 'none') return;
    if (buttons.length >= 5) return;
    const txt = (el.textContent || el.value || '').trim().substring(0, 30);
    if (!txt || txt.includes('{') || seen.has(txt)) return;
    seen.add(txt);
    buttons.push('[button ' + JSON.stringify(txt) + ']');
  });
  document.querySelectorAll('a[href]').forEach(el => {
    if (!el.offsetParent) return;
    if (links.length >= 8) return;
    const txt = el.textContent.trim().substring(0, 25);
    if (txt && !seen.has(txt)) { seen.add(txt); links.push(txt); }
  });
  const short = u.length > 80 ? u.substring(0, 80) + '...' : u;
  let r = '--- ' + short + ' | ' + t + ' ---';
  if (inputs.length) r += '\\n' + inputs.join(' ');
  if (buttons.length) r += '\\n' + buttons.join(' ');
  if (links.length) r += '\\nLinks: ' + links.join(', ');
  return r;
})()`;

async function getPageBrief(cdp) {
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: PAGE_BRIEF_SCRIPT,
      returnByValue: true,
    });
    return result.result.value || '';
  } catch { return ''; }
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
    // If a dialog handler is pending, activate it
    const state = loadSessionState();
    if (state.dialogHandler) {
      const { accept, promptText } = state.dialogHandler;
      await cdp.send('Page.enable');
      cdp.on('Page.javascriptDialogOpening', async (params) => {
        try {
          await cdp.send('Page.handleJavaScriptDialog', { accept, promptText });
          console.log(`Auto-${accept ? 'accepted' : 'dismissed'} ${params.type}: "${params.message}"`);
        } catch {}
      });
      delete state.dialogHandler;
      saveSessionState(state);
    }
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
  const userDataDir = path.join(TMP, 'webact-chrome-profile');
  const portFile = path.join(userDataDir, '.webact-port');

  // Resolve the right host for CDP connections (handles WSL2)
  if (IS_WSL) await resolveCDPHost();

  // Check if Chrome is already running from a previous session
  // The port changes each launch, so we save it to a file keyed to the user-data-dir
  try {
    const savedPort = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    if (savedPort) {
      CDP_PORT = savedPort;
      await getDebugTabs();
      console.log(`Browser already running.`);
      return cmdConnect();
    }
  } catch {
    // Saved port didn't respond — Chrome likely closed. Clean up stale file.
    try { fs.unlinkSync(portFile); } catch {}
  }

  // Determine port: env override or find a free one
  if (process.env.CDP_PORT) {
    CDP_PORT = parseInt(process.env.CDP_PORT, 10);
  } else {
    CDP_PORT = await findFreePort();
  }

  const browser = findBrowser();
  if (!browser) {
    console.error('No Chromium-based browser found.');
    console.error('Install one of: Google Chrome, Microsoft Edge, Brave, Chromium, Arc, Vivaldi, Opera');
    console.error('Or set CHROME_PATH to the browser executable.');
    process.exit(1);
  }

  let launchDataDir = userDataDir;
  const isWindowsBrowser = IS_WSL && browser.path.startsWith('/mnt/');

  // Windows browsers need Windows-style paths
  if (isWindowsBrowser) {
    launchDataDir = wslWindowsPath(userDataDir);
  }

  // Ensure user data dir exists so we can write the port file
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const spawnOpts = { stdio: 'ignore' };
  if (process.platform === 'win32') {
    spawnOpts.detached = false;
    spawnOpts.shell = true;
  } else {
    spawnOpts.detached = true;
  }

  const child = spawn(browser.path, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${launchDataDir}`,
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
      // Save the port so future launches can find this Chrome instance
      fs.writeFileSync(portFile, String(CDP_PORT));
      console.log(`${browser.name} launched successfully.`);
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
    port: CDP_PORT,
    host: CDP_HOST,
  };
  saveSessionState(state);

  // Save as last active session for auto-discovery
  fs.writeFileSync(LAST_SESSION_FILE, currentSessionId);

  console.log(`Session: ${currentSessionId}`);
}

async function cmdNavigate(url) {
  if (!url) { console.error('Usage: webact.js navigate <url>'); process.exit(1); }
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

    console.log(await getPageBrief(cdp));
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
    const outPath = path.join(TMP, `webact-screenshot-${currentSessionId || 'default'}.png`);
    fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'));
    console.log(`Screenshot saved to ${outPath}`);
  });
}

// Shared helper: wait for element, scroll into view, return coordinates
async function locateElement(cdp, selector) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `
      (async function() {
        const sel = ${JSON.stringify(selector)};
        let el;
        for (let i = 0; i < 50; i++) {
          el = document.querySelector(sel);
          if (el) break;
          await new Promise(r => setTimeout(r, 100));
        }
        if (!el) return { error: 'Element not found after 5s: ' + sel };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await new Promise(r => setTimeout(r, 50));
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
                 tag: el.tagName, text: (el.textContent || '').substring(0, 50).trim() };
      })()
    `,
    returnByValue: true,
    awaitPromise: true,
  });
  const loc = result.result.value;
  if (loc.error) { console.error(loc.error); process.exit(1); }
  return loc;
}

async function cmdClick(selector) {
  if (!selector) { console.error('Usage: webact.js click <selector>'); process.exit(1); }

  await withCDP(async (cdp) => {
    const loc = await locateElement(cdp, selector);

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1
    });

    console.log(`Clicked ${loc.tag.toLowerCase()} "${loc.text}"`);
    // Brief pause for any triggered navigation/render, then show page state
    await new Promise(r => setTimeout(r, 150));
    console.log(await getPageBrief(cdp));
  });
}

async function cmdDoubleClick(selector) {
  if (!selector) { console.error('Usage: webact.js doubleclick <selector>'); process.exit(1); }

  await withCDP(async (cdp) => {
    const loc = await locateElement(cdp, selector);

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 2
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 2
    });

    console.log(`Double-clicked ${loc.tag.toLowerCase()} "${loc.text}"`);
    await new Promise(r => setTimeout(r, 150));
    console.log(await getPageBrief(cdp));
  });
}

async function cmdHover(selector) {
  if (!selector) { console.error('Usage: webact.js hover <selector>'); process.exit(1); }

  await withCDP(async (cdp) => {
    const loc = await locateElement(cdp, selector);

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: loc.x, y: loc.y,
    });

    console.log(`Hovered ${loc.tag.toLowerCase()} "${loc.text}"`);
    await new Promise(r => setTimeout(r, 150));
    console.log(await getPageBrief(cdp));
  });
}

async function cmdFocus(selector) {
  if (!selector) { console.error('Usage: webact.js focus <selector>'); process.exit(1); }

  await withCDP(async (cdp) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (async function() {
          const sel = ${JSON.stringify(selector)};
          let el;
          for (let i = 0; i < 50; i++) {
            el = document.querySelector(sel);
            if (el) break;
            await new Promise(r => setTimeout(r, 100));
          }
          if (!el) return { error: 'Element not found after 5s: ' + sel };
          el.focus();
          return { tag: el.tagName, text: (el.textContent || '').substring(0, 50).trim() };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    const val = result.result.value;
    if (val.error) { console.error(val.error); process.exit(1); }
    console.log(`Focused <${val.tag.toLowerCase()}> "${val.text}"`);
  });
}

async function cmdSelect(selector, ...values) {
  if (!selector || values.length === 0) { console.error('Usage: webact.js select <selector> <value> [value2...]'); process.exit(1); }

  await withCDP(async (cdp) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (async function() {
          const sel = ${JSON.stringify(selector)};
          const vals = ${JSON.stringify(values)};
          let el;
          for (let i = 0; i < 50; i++) {
            el = document.querySelector(sel);
            if (el) break;
            await new Promise(r => setTimeout(r, 100));
          }
          if (!el) return { error: 'Element not found after 5s: ' + sel };
          if (el.tagName !== 'SELECT') return { error: 'Element is not a <select>: ' + sel };
          const matched = [];
          for (const opt of el.options) {
            const match = vals.some(v => opt.value === v || opt.textContent.trim() === v || opt.label === v);
            opt.selected = match;
            if (match) matched.push(opt.textContent.trim() || opt.value);
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (matched.length === 0) return { error: 'No options matched: ' + vals.join(', ') };
          return { selected: matched };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    const val = result.result.value;
    if (val.error) { console.error(val.error); process.exit(1); }
    console.log(`Selected: ${val.selected.join(', ')}`);
    console.log(await getPageBrief(cdp));
  });
}

async function cmdUpload(selector, ...filePaths) {
  if (!selector || filePaths.length === 0) { console.error('Usage: webact.js upload <selector> <file> [file2...]'); process.exit(1); }

  // Resolve absolute paths
  const resolved = filePaths.map(f => path.resolve(f));
  for (const f of resolved) {
    if (!fs.existsSync(f)) { console.error(`File not found: ${f}`); process.exit(1); }
  }

  await withCDP(async (cdp) => {
    // Enable DOM to use querySelector on the backend
    await cdp.send('DOM.enable');
    const doc = await cdp.send('DOM.getDocument');
    const node = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!node.nodeId) { console.error(`Element not found: ${selector}`); process.exit(1); }
    await cdp.send('DOM.setFileInputFiles', {
      nodeId: node.nodeId,
      files: resolved,
    });
    console.log(`Uploaded ${resolved.length} file(s) to ${selector}: ${resolved.map(f => path.basename(f)).join(', ')}`);
  });
}

async function cmdDrag(fromSelector, toSelector) {
  if (!fromSelector || !toSelector) { console.error('Usage: webact.js drag <from-selector> <to-selector>'); process.exit(1); }

  await withCDP(async (cdp) => {
    const from = await locateElement(cdp, fromSelector);
    const to = await locateElement(cdp, toSelector);

    // Move to source, press, move to target, release
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from.x, y: from.y,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1,
    });
    // Intermediate steps for drag recognition
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + (to.x - from.x) * (i / steps);
      const y = from.y + (to.y - from.y) * (i / steps);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y,
      });
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1,
    });

    console.log(`Dragged ${from.tag.toLowerCase()} to ${to.tag.toLowerCase()}`);
    console.log(await getPageBrief(cdp));
  });
}

async function cmdType(selector, text) {
  if (!selector || !text) { console.error('Usage: webact.js type <selector> <text>'); process.exit(1); }

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

async function cmdKeyboard(text) {
  if (!text) { console.error('Usage: webact.js keyboard <text>'); process.exit(1); }

  await withCDP(async (cdp) => {
    for (const char of text) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', text: char, unmodifiedText: char,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', text: char, unmodifiedText: char,
      });
    }
    console.log(`OK keyboard "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
  });
}

async function cmdWaitFor(selector, timeoutMs) {
  if (!selector) { console.error('Usage: webact.js waitfor <selector> [timeout_ms]'); process.exit(1); }
  const timeout = parseInt(timeoutMs, 10) || 5000;

  await withCDP(async (cdp) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (async function() {
          const sel = ${JSON.stringify(selector)};
          const deadline = Date.now() + ${timeout};
          while (Date.now() < deadline) {
            const el = document.querySelector(sel);
            if (el) {
              const text = (el.textContent || '').substring(0, 200).trim();
              const tag = el.tagName.toLowerCase();
              return { found: true, tag, text };
            }
            await new Promise(r => setTimeout(r, 100));
          }
          return { found: false };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });

    const val = result.result.value;
    if (!val.found) {
      console.error(`Element not found after ${timeout}ms: ${selector}`);
      process.exit(1);
    }
    console.log(`Found ${val.tag} "${val.text}"`);
    console.log(await getPageBrief(cdp));
  });
}

async function cmdDialog(action, promptText) {
  const validActions = ['accept', 'dismiss'];
  if (!action || !validActions.includes(action.toLowerCase())) {
    console.error('Usage: webact.js dialog <accept|dismiss> [prompt-text]');
    console.error('Sets up auto-handling for the next dialog. Run BEFORE the action that triggers it.');
    process.exit(1);
  }

  const accept = action.toLowerCase() === 'accept';
  const state = loadSessionState();
  state.dialogHandler = { accept, promptText: promptText || '' };
  saveSessionState(state);
  console.log(`Dialog handler set: will ${accept ? 'accept' : 'dismiss'} the next dialog${promptText ? ` with text: "${promptText}"` : ''}`);
}

async function cmdWaitForNavigation(timeoutMs) {
  const timeout = parseInt(timeoutMs, 10) || 10000;

  await withCDP(async (cdp) => {
    await cdp.send('Page.enable');

    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        (async function() {
          const deadline = Date.now() + ${timeout};
          // Wait for readyState to be complete
          while (Date.now() < deadline) {
            if (document.readyState === 'complete') {
              return { ready: true, url: location.href, title: document.title };
            }
            await new Promise(r => setTimeout(r, 100));
          }
          return { ready: false, url: location.href, readyState: document.readyState };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });

    const val = result.result.value;
    if (!val.ready) {
      console.error(`Page not ready after ${timeout}ms (readyState: ${val.readyState})`);
      process.exit(1);
    }
    console.log(await getPageBrief(cdp));
  });
}

async function cmdPress(key) {
  if (!key) { console.error('Usage: webact.js press <key>'); process.exit(1); }

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
    console.log(`OK press ${key}`);
    // Enter/Tab/Escape can trigger navigation or state changes
    if (['enter', 'tab', 'escape'].includes(key.toLowerCase())) {
      await new Promise(r => setTimeout(r, 150));
      console.log(await getPageBrief(cdp));
    }
  });
}

async function cmdScroll(direction) {
  if (!direction) { console.error('Usage: webact.js scroll <up|down>'); process.exit(1); }
  const deltaY = direction.toLowerCase() === 'up' ? -400 : 400;

  await withCDP(async (cdp) => {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY,
    });
    console.log(await getPageBrief(cdp));
  });
}

async function cmdEval(expression) {
  if (!expression) { console.error('Usage: webact.js eval <js-expression>'); process.exit(1); }

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
  if (!id) { console.error('Usage: webact.js tab <id>'); process.exit(1); }
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
  await httpPut(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${id}`);
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
  await httpPut(`http://${CDP_HOST}:${CDP_PORT}/json/close/${tabId}`);

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
    case 'doubleclick': await cmdDoubleClick(args.join(' ')); break;
    case 'hover': await cmdHover(args.join(' ')); break;
    case 'focus': await cmdFocus(args.join(' ')); break;
    case 'type': {
      const selector = args[0];
      const text = args.slice(1).join(' ');
      await cmdType(selector, text);
      break;
    }
    case 'keyboard': await cmdKeyboard(args.join(' ')); break;
    case 'select': await cmdSelect(args[0], ...args.slice(1)); break;
    case 'upload': await cmdUpload(args[0], ...args.slice(1)); break;
    case 'drag': await cmdDrag(args[0], args[1]); break;
    case 'dialog': await cmdDialog(args[0], args.slice(1).join(' ') || undefined); break;
    case 'waitfor': await cmdWaitFor(args[0], args[1]); break;
    case 'waitfornav': await cmdWaitForNavigation(args[0]); break;
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
    console.log(`Usage: webact.js <command> [args]

Commands:
  launch              Launch Chrome and start a session
  navigate <url>      Navigate to URL
  dom [selector]      Get compact DOM (--full for no truncation)
  screenshot          Capture screenshot
  click <selector>    Click an element (waits up to 5s, scrolls into view)
  doubleclick <sel>   Double-click an element
  hover <selector>    Hover over an element (triggers tooltips/menus)
  focus <selector>    Focus an element without clicking
  type <sel> <text>   Type text into element (focuses selector first)
  keyboard <text>     Type text at current caret position (no selector)
  select <sel> <val>  Select option(s) from a <select> by value or label
  upload <sel> <file> Upload file(s) to a file input
  drag <from> <to>    Drag from one element to another
  dialog <accept|dismiss> [text]  Handle alert/confirm/prompt dialog
  waitfor <sel> [ms]  Wait for element to appear (default 5000ms)
  waitfornav [ms]     Wait for page navigation to complete (default 10000ms)
  press <key>         Press a key (Enter, Tab, Escape, etc.)
  scroll <up|down>    Scroll the page
  eval <js>           Evaluate JavaScript
  tabs                List this session's tabs
  tab <id>            Switch to a session-owned tab
  newtab [url]        Open a new tab in this session
  close               Close current tab`);
    process.exit(0);
  }

  try {
    // Set port from env for standalone commands (non-launch, non-run)
    if (process.env.CDP_PORT) {
      CDP_PORT = parseInt(process.env.CDP_PORT, 10);
    }

    if (command === 'run') {
      const sessionId = args[0];
      if (!sessionId) {
        console.error('Usage: webact.js run <sessionId>');
        process.exit(1);
      }
      currentSessionId = sessionId;

      // Restore port and host from session state
      const state = loadSessionState();
      if (state.port) CDP_PORT = state.port;
      if (state.host) CDP_HOST = state.host;

      // Inline command: node webact.js run <sid> navigate https://example.com
      if (args.length > 1) {
        await dispatch(args[1], args.slice(2));
      } else {
        // File-based command (supports chaining via arrays)
        const cmdFile = path.join(TMP, `webact-command-${sessionId}.json`);
        let cmdData;
        try {
          cmdData = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
        } catch (e) {
          console.error(`Cannot read ${cmdFile}: ${e.message}`);
          process.exit(1);
        }
        const commands = Array.isArray(cmdData) ? cmdData : [cmdData];
        for (const cmd of commands) {
          if (!cmd.command) {
            console.error(`Missing "command" field in: ${JSON.stringify(cmd)}`);
            process.exit(1);
          }
          await dispatch(cmd.command, cmd.args || []);
        }
      }
    } else if (command !== 'launch' && command !== 'connect') {
      // Direct command: auto-discover last session
      try {
        const lastSid = fs.readFileSync(LAST_SESSION_FILE, 'utf8').trim();
        currentSessionId = lastSid;
        const state = loadSessionState();
        if (state.port) CDP_PORT = state.port;
        if (state.host) CDP_HOST = state.host;
      } catch {
        console.error('No active session. Run: node webact.js launch');
        process.exit(1);
      }
      await dispatch(command, args);
    } else {
      await dispatch(command, args);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
