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

// --- Ref-based targeting ---

// Injected into the page to generate unique CSS selectors for elements
const SELECTOR_GEN_SCRIPT = `if (!window.__webactGenSelector) {
  window.__webactGenSelector = function(el) {
    if (el.id) {
      try {
        var sel = '#' + CSS.escape(el.id);
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch(e) {}
    }
    var tid = el.getAttribute('data-testid');
    if (tid && tid.indexOf('"') < 0 && tid.indexOf(']') < 0) {
      var sel = '[data-testid="' + tid + '"]';
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch(e) {}
    }
    var al = el.getAttribute('aria-label');
    if (al && al.indexOf('"') < 0 && al.indexOf(']') < 0) {
      var sel = '[aria-label="' + al + '"]';
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch(e) {}
    }
    var parts = [];
    var cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      var tag = cur.tagName.toLowerCase();
      var parent = cur.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === cur.tagName; });
        if (siblings.length > 1) tag += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }
      parts.unshift(tag);
      cur = parent;
    }
    return parts.join(' > ');
  };
}`;

// Resolve a ref number (e.g. "3") to a CSS selector using the stored ref map
function resolveSelector(input) {
  if (/^\d+$/.test(input)) {
    const state = loadSessionState();
    if (!state.refMap) throw new Error('No ref map. Run: axtree -i');
    const selector = state.refMap[input];
    if (!selector) throw new Error(`Ref ${input} not found. Run: axtree -i to refresh.`);
    return selector;
  }
  return input;
}

// --- Action cache ---

const ACTION_CACHE_FILE = path.join(TMP, 'webact-action-cache.json');
const CACHE_TTL = 48 * 60 * 60 * 1000; // 48 hours
const CACHE_MAX_ENTRIES = 100;

function loadActionCache() {
  try { return JSON.parse(fs.readFileSync(ACTION_CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveActionCache(cache) {
  const now = Date.now();
  for (const key of Object.keys(cache)) {
    if (now - cache[key].timestamp > CACHE_TTL) delete cache[key];
  }
  const entries = Object.entries(cache).sort((a, b) => b[1].timestamp - a[1].timestamp);
  const pruned = entries.length > CACHE_MAX_ENTRIES
    ? Object.fromEntries(entries.slice(0, CACHE_MAX_ENTRIES))
    : cache;
  fs.writeFileSync(ACTION_CACHE_FILE, JSON.stringify(pruned));
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
  const totalInputs = document.querySelectorAll('input:not([type=hidden]),textarea,select').length;
  const totalButtons = document.querySelectorAll('button,[role=button],input[type=submit]').length;
  const totalLinks = document.querySelectorAll('a[href]').length;
  const short = u.length > 80 ? u.substring(0, 80) + '...' : u;
  let r = '--- ' + short + ' | ' + t + ' ---';
  if (inputs.length) r += '\\n' + inputs.join(' ');
  if (buttons.length) r += '\\n' + buttons.join(' ');
  if (links.length) r += '\\nLinks: ' + links.join(', ');
  const counts = [];
  if (totalInputs > inputs.length) counts.push(totalInputs + ' inputs');
  if (totalButtons > buttons.length) counts.push(totalButtons + ' buttons');
  if (totalLinks > links.length) counts.push(totalLinks + ' links');
  if (counts.length) r += '\\n(' + counts.join(', ') + ' total — use dom or axtree for full list)';
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
    const state = loadSessionState();

    // If a dialog handler is pending, activate it
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

    // If network blocking is configured, apply it
    if (state.blockPatterns) {
      const { resourceTypes, urlPatterns } = state.blockPatterns;
      await cdp.send('Fetch.enable', {
        patterns: [{ requestStage: 'Request' }],
      });
      cdp.on('Fetch.requestPaused', async (params) => {
        try {
          const rt = params.resourceType;
          const url = params.request.url;
          const blocked = resourceTypes.includes(rt) ||
            urlPatterns.some(p => url.includes(p));
          if (blocked) {
            await cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
          } else {
            await cdp.send('Fetch.continueRequest', { requestId: params.requestId });
          }
        } catch {}
      });
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

  // Clear stale ref map — new page invalidates old refs
  const state = loadSessionState();
  if (state.refMap) {
    delete state.refMap;
    delete state.refMapUrl;
    delete state.refMapTimestamp;
    saveSessionState(state);
  }

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
    'home': { key: 'Home', code: 'Home', keyCode: 36 },
    'end': { key: 'End', code: 'End', keyCode: 35 },
    'pageup': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    'pagedown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  };

  // Handle key combos: Ctrl+A, Shift+Enter, Meta+C, etc.
  if (key.includes('+')) {
    const { modifiers, key: mainKey } = parseKeyCombo(key);
    const mapped = keyMap[mainKey.toLowerCase()] || {
      key: mainKey.length === 1 ? mainKey : mainKey,
      code: mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey,
      keyCode: mainKey.length === 1 ? mainKey.toUpperCase().charCodeAt(0) : 0,
    };
    const modBits = (modifiers.alt ? 1 : 0) | (modifiers.ctrl ? 2 : 0) | (modifiers.meta ? 4 : 0) | (modifiers.shift ? 8 : 0);

    await withCDP(async (cdp) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', ...mapped,
        windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode,
        modifiers: modBits,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', ...mapped,
        windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode,
        modifiers: modBits,
      });
      console.log(`OK press ${key}`);
      if (['enter', 'tab', 'escape'].includes(mainKey.toLowerCase())) {
        await new Promise(r => setTimeout(r, 150));
        console.log(await getPageBrief(cdp));
      }
    });
    return;
  }

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

async function cmdScroll(target, amount) {
  if (!target) { console.error('Usage: webact.js scroll <up|down|top|bottom|selector> [pixels]'); process.exit(1); }

  const lower = target.toLowerCase();

  await withCDP(async (cdp) => {
    if (lower === 'top') {
      await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' });
    } else if (lower === 'bottom') {
      await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight)' });
    } else if (lower === 'up' || lower === 'down') {
      const pixels = parseInt(amount, 10) || 400;
      const deltaY = lower === 'up' ? -pixels : pixels;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY,
      });
    } else {
      // Treat as CSS selector — scroll element into view
      const result = await cdp.send('Runtime.evaluate', {
        expression: `
          (function() {
            const el = document.querySelector(${JSON.stringify(target)});
            if (!el) return { error: 'Element not found: ${target}' };
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return { tag: el.tagName.toLowerCase() };
          })()
        `,
        returnByValue: true,
      });
      const val = result.result.value;
      if (val.error) { console.error(val.error); process.exit(1); }
      console.log(`Scrolled to ${val.tag} ${target}`);
    }
    await new Promise(r => setTimeout(r, 100));
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

// --- Tier 1: axtree, cookies, back/forward/reload, rightclick, key combos, clear, pdf ---

// Helper: fetch interactive elements, generate ref map, cache results
// Called from within a withCDP callback — receives the cdp connection
async function fetchInteractiveElements(cdp) {
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
    'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'listbox', 'tree', 'treeitem',
  ]);

  // Get current URL for cache key
  const urlResult = await cdp.send('Runtime.evaluate', {
    expression: 'location.href', returnByValue: true,
  });
  const currentUrl = urlResult.result.value;
  let cacheKey;
  try { const u = new URL(currentUrl); cacheKey = u.hostname + u.pathname; }
  catch { cacheKey = currentUrl; }

  // Check action cache
  const actionCache = loadActionCache();
  const cached = actionCache[cacheKey];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    const refs = Object.entries(cached.refMap);
    const checkRefs = refs.slice(0, Math.min(3, refs.length));
    let valid = checkRefs.length > 0;
    for (const [, sel] of checkRefs) {
      try {
        const check = await cdp.send('Runtime.evaluate', {
          expression: `!!document.querySelector(${JSON.stringify(sel)})`,
          returnByValue: true,
        });
        if (!check.result?.value) { valid = false; break; }
      } catch { valid = false; break; }
    }
    if (valid) {
      const state = loadSessionState();
      state.refMap = cached.refMap;
      state.refMapUrl = currentUrl;
      state.refMapTimestamp = cached.timestamp;
      saveSessionState(state);
      return { elements: cached.elements, refMap: cached.refMap, output: cached.output };
    }
  }

  // Fresh AX tree walk
  await cdp.send('Accessibility.enable');
  const axResult = await cdp.send('Accessibility.getFullAXTree', { depth: 8 });
  const nodes = axResult.nodes;
  const nodeMap = new Map();
  for (const n of nodes) nodeMap.set(n.nodeId, n);

  // Collect interactive nodes
  const interactiveNodes = [];
  function walk(node) {
    const role = node.role?.value || '';
    if (INTERACTIVE_ROLES.has(role)) interactiveNodes.push(node);
    for (const cid of (node.childIds || [])) {
      const child = nodeMap.get(cid);
      if (child) walk(child);
    }
  }
  if (nodes[0]) walk(nodes[0]);

  // Build output text + elements array
  const elements = [];
  let output = '';
  for (let i = 0; i < interactiveNodes.length; i++) {
    const node = interactiveNodes[i];
    const role = node.role?.value || '';
    const name = node.name?.value || '';
    const value = node.value?.value || '';
    let line = `[${i + 1}] ${role}`;
    if (name) line += ` "${name.substring(0, 80)}"`;
    if (value) line += ` val="${value.substring(0, 40)}"`;
    const props = {};
    for (const p of (node.properties || [])) {
      if (p.name === 'disabled' && p.value?.value) props.disabled = true;
      if (p.name === 'checked') props.checked = p.value?.value;
      if (p.name === 'expanded') props.expanded = p.value?.value;
      if (p.name === 'selected' && p.value?.value) props.selected = true;
    }
    const propStr = Object.entries(props).map(([k,v]) => `${k}=${v}`).join(' ');
    if (propStr) line += ` [${propStr}]`;
    output += line + '\n';
    elements.push({ role, name, value });
  }
  if (output.length > 6000) {
    output = output.substring(0, 6000) + '\n... (truncated)';
  }

  // Inject selector generator and resolve CSS selectors in parallel
  await cdp.send('Runtime.evaluate', { expression: SELECTOR_GEN_SCRIPT });
  await cdp.send('DOM.enable');
  const refMap = {};
  await Promise.all(interactiveNodes.map(async (node, i) => {
    try {
      if (!node.backendDOMNodeId) return;
      const resolved = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
      if (!resolved.object?.objectId) return;
      const sResult = await cdp.send('Runtime.callFunctionOn', {
        objectId: resolved.object.objectId,
        functionDeclaration: 'function() { return window.__webactGenSelector(this); }',
        returnByValue: true,
      });
      if (sResult.result?.value) refMap[i + 1] = sResult.result.value;
    } catch {}
  }));

  await cdp.send('Accessibility.disable');

  // Save ref map to session state
  const state = loadSessionState();
  state.refMap = refMap;
  state.refMapUrl = currentUrl;
  state.refMapTimestamp = Date.now();
  saveSessionState(state);

  // Save to action cache
  actionCache[cacheKey] = { refMap, elements, output, timestamp: Date.now() };
  saveActionCache(actionCache);

  return { elements, refMap, output };
}

async function cmdAxtree(selector, interactiveOnly) {
  await withCDP(async (cdp) => {
    // Fast path: interactive-only without selector — uses cache + ref map
    if (interactiveOnly && !selector) {
      const data = await fetchInteractiveElements(cdp);
      console.log(data.output || '(no interactive elements found)');
      return;
    }

    await cdp.send('Accessibility.enable');

    let nodes;
    if (selector) {
      const objResult = await cdp.send('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
      });
      if (!objResult.result.objectId) {
        console.error(`Element not found: ${selector}`);
        process.exit(1);
      }
      const result = await cdp.send('Accessibility.queryAXTree', {
        objectId: objResult.result.objectId,
      });
      nodes = result.nodes;
    } else {
      const result = await cdp.send('Accessibility.getFullAXTree', { depth: 8 });
      nodes = result.nodes;
    }

    const SKIP_ROLES = new Set(['InlineTextBox', 'LineBreak']);
    const PASS_THROUGH_ROLES = new Set(['none', 'generic']);
    const INTERACTIVE_ROLES = new Set([
      'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
      'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'option', 'listbox', 'tree', 'treeitem',
    ]);
    const nodeMap = new Map();
    for (const n of nodes) nodeMap.set(n.nodeId, n);

    if (interactiveOnly) {
      // Flat list of interactive elements with indices — token-efficient
      let idx = 1;
      let output = '';
      function collectInteractive(node) {
        const role = node.role?.value || '';
        if (INTERACTIVE_ROLES.has(role)) {
          const name = node.name?.value || '';
          const value = node.value?.value || '';
          let line = `[${idx}] ${role}`;
          if (name) line += ` "${name.substring(0, 80)}"`;
          if (value) line += ` val="${value.substring(0, 40)}"`;
          const props = {};
          for (const p of (node.properties || [])) {
            if (p.name === 'disabled' && p.value?.value) props.disabled = true;
            if (p.name === 'checked') props.checked = p.value?.value;
            if (p.name === 'expanded') props.expanded = p.value?.value;
            if (p.name === 'selected' && p.value?.value) props.selected = true;
          }
          const propStr = Object.entries(props).map(([k,v]) => `${k}=${v}`).join(' ');
          if (propStr) line += ` [${propStr}]`;
          output += line + '\n';
          idx++;
        }
        for (const cid of (node.childIds || [])) {
          const child = nodeMap.get(cid);
          if (child) collectInteractive(child);
        }
      }
      if (nodes[0]) collectInteractive(nodes[0]);
      if (output.length > 6000) {
        output = output.substring(0, 6000) + '\n... (truncated)';
      }
      console.log(output || '(no interactive elements found)');
    } else {
      // Full tree format
      function formatNode(node, depth) {
        const role = node.role?.value || '';
        if (SKIP_ROLES.has(role)) return '';

        const name = node.name?.value || '';
        const value = node.value?.value || '';
        const isPassThrough = PASS_THROUGH_ROLES.has(role) && !name;

        let out = '';

        if (!isPassThrough) {
          if (role === 'StaticText') {
            const indent = '  '.repeat(Math.min(depth, 6));
            if (name.length > 80) {
              out += `${indent}- text "${name.substring(0, 80)}..."\n`;
            }
            return out;
          }

          const indent = '  '.repeat(Math.min(depth, 6));
          let line = `${indent}- ${role}`;
          if (name) line += ` "${name.substring(0, 80)}"`;
          if (value) line += ` value="${value.substring(0, 60)}"`;

          const props = {};
          for (const p of (node.properties || [])) {
            if (p.name === 'disabled' && p.value?.value) props.disabled = true;
            if (p.name === 'required' && p.value?.value) props.required = true;
            if (p.name === 'checked') props.checked = p.value?.value;
            if (p.name === 'expanded') props.expanded = p.value?.value;
            if (p.name === 'selected' && p.value?.value) props.selected = true;
          }
          const propStr = Object.entries(props).map(([k,v]) => `${k}=${v}`).join(' ');
          if (propStr) line += ` [${propStr}]`;

          out += line + '\n';
        }

        const childIds = node.childIds || [];
        for (const cid of childIds) {
          const child = nodeMap.get(cid);
          if (child) out += formatNode(child, isPassThrough ? depth : depth + 1);
        }
        return out;
      }

      const root = nodes[0];
      let output = '';
      if (root) {
        output = formatNode(root, 0);
      }
      if (output.length > 6000) {
        output = output.substring(0, 6000) + '\n... (truncated)';
      }
      console.log(output || '(empty accessibility tree)');
    }

    await cdp.send('Accessibility.disable');
  });
}

async function cmdObserve() {
  await withCDP(async (cdp) => {
    const data = await fetchInteractiveElements(cdp);
    if (data.elements.length === 0) {
      console.log('(no interactive elements found)');
      return;
    }

    let output = '';
    for (let i = 0; i < data.elements.length; i++) {
      const el = data.elements[i];
      const ref = i + 1;
      const desc = `${el.role}${el.name ? ' "' + el.name.substring(0, 60) + '"' : ''}`;
      let cmd;
      switch (el.role) {
        case 'textbox':
        case 'searchbox':
          cmd = `type ${ref} <text>`;
          break;
        case 'combobox':
        case 'listbox':
          cmd = `select ${ref} <value>`;
          break;
        case 'slider':
        case 'spinbutton':
          cmd = `type ${ref} <value>`;
          break;
        default:
          cmd = `click ${ref}`;
      }
      output += `[${ref}] ${cmd}  — ${desc}\n`;
    }
    console.log(output.trimEnd());
  });
}

async function cmdCookies(action, ...args) {
  if (!action) {
    // Default: get all cookies for current page
    action = 'get';
  }

  switch (action.toLowerCase()) {
    case 'get': {
      await withCDP(async (cdp) => {
        const result = await cdp.send('Network.getCookies');
        if (result.cookies.length === 0) {
          console.log('No cookies.');
          return;
        }
        for (const c of result.cookies) {
          const flags = [];
          if (c.httpOnly) flags.push('httpOnly');
          if (c.secure) flags.push('secure');
          if (c.session) flags.push('session');
          const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString().split('T')[0] : '';
          console.log(`${c.name}=${c.value.substring(0, 60)}${c.value.length > 60 ? '...' : ''} (${c.domain}${exp ? ' exp:' + exp : ''} ${flags.join(' ')})`);
        }
      });
      break;
    }
    case 'set': {
      if (args.length < 2) {
        console.error('Usage: webact.js cookies set <name> <value> [domain]');
        process.exit(1);
      }
      const [name, value, domain] = args;
      await withCDP(async (cdp) => {
        const cookieDomain = domain || await cdp.send('Runtime.evaluate', {
          expression: 'location.hostname', returnByValue: true,
        }).then(r => r.result.value);

        await cdp.send('Network.setCookie', {
          name, value, domain: cookieDomain, path: '/',
        });
        console.log(`Cookie set: ${name}=${value.substring(0, 40)} (${cookieDomain})`);
      });
      break;
    }
    case 'clear': {
      await withCDP(async (cdp) => {
        await cdp.send('Network.clearBrowserCookies');
        console.log('All cookies cleared.');
      });
      break;
    }
    case 'delete': {
      if (!args[0]) {
        console.error('Usage: webact.js cookies delete <name> [domain]');
        process.exit(1);
      }
      await withCDP(async (cdp) => {
        const domain = args[1] || await cdp.send('Runtime.evaluate', {
          expression: 'location.hostname', returnByValue: true,
        }).then(r => r.result.value);

        await cdp.send('Network.deleteCookies', { name: args[0], domain });
        console.log(`Deleted cookie: ${args[0]} (${domain})`);
      });
      break;
    }
    default:
      console.error('Usage: webact.js cookies [get|set|clear|delete] [args]');
      process.exit(1);
  }
}

async function cmdBack() {
  await withCDP(async (cdp) => {
    const nav = await cdp.send('Page.getNavigationHistory');
    if (nav.currentIndex <= 0) {
      console.error('No previous page in history.');
      process.exit(1);
    }
    const entry = nav.entries[nav.currentIndex - 1];
    await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    await new Promise(r => setTimeout(r, 500));
    console.log(await getPageBrief(cdp));
  });
}

async function cmdForward() {
  await withCDP(async (cdp) => {
    const nav = await cdp.send('Page.getNavigationHistory');
    if (nav.currentIndex >= nav.entries.length - 1) {
      console.error('No next page in history.');
      process.exit(1);
    }
    const entry = nav.entries[nav.currentIndex + 1];
    await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    await new Promise(r => setTimeout(r, 500));
    console.log(await getPageBrief(cdp));
  });
}

async function cmdReload() {
  await withCDP(async (cdp) => {
    await cdp.send('Page.reload');
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

async function cmdRightClick(selector) {
  if (!selector) { console.error('Usage: webact.js rightclick <selector>'); process.exit(1); }

  await withCDP(async (cdp) => {
    const loc = await locateElement(cdp, selector);

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: loc.x, y: loc.y, button: 'right', clickCount: 1
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: loc.x, y: loc.y, button: 'right', clickCount: 1
    });

    console.log(`Right-clicked ${loc.tag.toLowerCase()} "${loc.text}"`);
    await new Promise(r => setTimeout(r, 150));
    console.log(await getPageBrief(cdp));
  });
}

async function cmdClear(selector) {
  if (!selector) { console.error('Usage: webact.js clear <selector>'); process.exit(1); }

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
          if ('value' in el) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return { tag: el.tagName };
        })()
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    const val = result.result.value;
    if (val.error) { console.error(val.error); process.exit(1); }
    console.log(`Cleared ${val.tag.toLowerCase()} ${selector}`);
  });
}

async function cmdPdf(outputPath) {
  const outFile = outputPath || path.join(TMP, `webact-page-${currentSessionId || 'default'}.pdf`);

  await withCDP(async (cdp) => {
    const result = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    });
    fs.writeFileSync(outFile, Buffer.from(result.data, 'base64'));
    console.log(`PDF saved to ${outFile}`);
  });
}

// Parse key combo strings like "Ctrl+A", "Shift+Enter", "Meta+C"
function parseKeyCombo(combo) {
  const parts = combo.split('+');
  const modifiers = { ctrl: false, alt: false, shift: false, meta: false };
  let key = '';

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') modifiers.ctrl = true;
    else if (lower === 'alt' || lower === 'option') modifiers.alt = true;
    else if (lower === 'shift') modifiers.shift = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers.meta = true;
    else key = part;
  }

  return { modifiers, key };
}

// --- Tier 2: console, network blocking, viewport, frames, download, scroll improvements ---

async function cmdConsole(action) {
  if (!action) action = 'show';

  if (action === 'show' || action === 'errors') {
    await withCDP(async (cdp) => {
      await cdp.send('Runtime.enable');
      const logs = [];
      let collecting = true;

      cdp.on('Runtime.consoleAPICalled', (params) => {
        if (!collecting) return;
        const type = params.type; // log, warn, error, info
        if (action === 'errors' && type !== 'error') return;
        const text = params.args.map(a => a.value || a.description || '').join(' ');
        logs.push(`[${type}] ${text.substring(0, 200)}`);
      });

      cdp.on('Runtime.exceptionThrown', (params) => {
        if (!collecting) return;
        const desc = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Unknown error';
        logs.push(`[exception] ${desc.substring(0, 200)}`);
      });

      // Wait briefly to collect any pending logs
      await new Promise(r => setTimeout(r, 1000));
      collecting = false;

      if (logs.length === 0) {
        console.log('No console output captured (listened for 1s).');
      } else {
        console.log(logs.join('\n'));
      }
    });
  } else if (action === 'listen') {
    // Long-running listener — prints in real time until Ctrl+C
    await withCDP(async (cdp) => {
      await cdp.send('Runtime.enable');
      console.log('Listening for console output (Ctrl+C to stop)...');

      cdp.on('Runtime.consoleAPICalled', (params) => {
        const type = params.type;
        const text = params.args.map(a => a.value || a.description || '').join(' ');
        console.log(`[${type}] ${text.substring(0, 500)}`);
      });

      cdp.on('Runtime.exceptionThrown', (params) => {
        const desc = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Unknown error';
        console.log(`[exception] ${desc.substring(0, 500)}`);
      });

      // Keep alive until process is killed
      await new Promise(() => {});
    });
  } else {
    console.error('Usage: webact.js console [show|errors|listen]');
    process.exit(1);
  }
}

async function cmdBlock(...patterns) {
  if (patterns.length === 0) {
    console.error('Usage: webact.js block <pattern> [pattern2...]\nPatterns: images, css, fonts, media, scripts, or URL substring\nUse "block off" to disable blocking.');
    process.exit(1);
  }

  const state = loadSessionState();

  if (patterns[0] === 'off') {
    delete state.blockPatterns;
    saveSessionState(state);
    console.log('Request blocking disabled.');
    return;
  }

  // Expand shorthand patterns to resource types
  const RESOURCE_TYPES = {
    'images': 'Image',
    'css': 'Stylesheet',
    'fonts': 'Font',
    'media': 'Media',
    'scripts': 'Script',
  };

  const resourceTypes = [];
  const urlPatterns = [];

  for (const p of patterns) {
    if (RESOURCE_TYPES[p.toLowerCase()]) {
      resourceTypes.push(RESOURCE_TYPES[p.toLowerCase()]);
    } else {
      urlPatterns.push(p);
    }
  }

  state.blockPatterns = { resourceTypes, urlPatterns };
  saveSessionState(state);

  console.log(`Blocking: ${patterns.join(', ')}. Takes effect on next page load.`);
}

async function cmdViewport(width, height) {
  if (!width) {
    console.error('Usage: webact.js viewport <width> <height>\nPresets: mobile (375x667), tablet (768x1024), desktop (1280x800)');
    process.exit(1);
  }

  // Handle presets
  const presets = {
    'mobile': { w: 375, h: 667, dpr: 2, mobile: true },
    'iphone': { w: 390, h: 844, dpr: 3, mobile: true },
    'ipad': { w: 820, h: 1180, dpr: 2, mobile: true },
    'tablet': { w: 768, h: 1024, dpr: 2, mobile: true },
    'desktop': { w: 1280, h: 800, dpr: 1, mobile: false },
  };

  let w, h, dpr = 1, mobile = false;
  const preset = presets[width.toLowerCase()];
  if (preset) {
    w = preset.w; h = preset.h; dpr = preset.dpr; mobile = preset.mobile;
  } else {
    w = parseInt(width, 10);
    h = parseInt(height, 10) || Math.round(w * 0.625); // 16:10 default
    if (isNaN(w)) {
      console.error('Invalid width. Use a number or preset: mobile, tablet, desktop');
      process.exit(1);
    }
  }

  await withCDP(async (cdp) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: dpr, mobile,
    });
    console.log(`Viewport set to ${w}x${h} (dpr:${dpr}${mobile ? ' mobile' : ''})`);
  });
}

async function cmdFrames() {
  await withCDP(async (cdp) => {
    const tree = await cdp.send('Page.getFrameTree');

    function printFrame(frame, depth) {
      const indent = '  '.repeat(depth);
      const name = frame.frame.name ? ` name="${frame.frame.name}"` : '';
      const id = frame.frame.id;
      console.log(`${indent}[${id}]${name} ${frame.frame.url}`);
      for (const child of (frame.childFrames || [])) {
        printFrame(child, depth + 1);
      }
    }

    await cdp.send('Page.enable');
    printFrame(tree.frameTree, 0);
  });
}

async function cmdFrame(frameIdOrSelector) {
  if (!frameIdOrSelector) {
    console.error('Usage: webact.js frame <frameId|selector>\nUse "webact.js frames" to list available frames.\nUse "webact.js frame main" to return to main frame.');
    process.exit(1);
  }

  const state = loadSessionState();

  if (frameIdOrSelector === 'main' || frameIdOrSelector === 'top') {
    delete state.activeFrameId;
    saveSessionState(state);
    console.log('Switched to main frame.');
    return;
  }

  await withCDP(async (cdp) => {
    await cdp.send('Page.enable');
    const tree = await cdp.send('Page.getFrameTree');

    // Try to find frame by ID or name
    function findFrame(node) {
      if (node.frame.id === frameIdOrSelector || node.frame.name === frameIdOrSelector) {
        return node.frame;
      }
      for (const child of (node.childFrames || [])) {
        const found = findFrame(child);
        if (found) return found;
      }
      return null;
    }

    let frame = findFrame(tree.frameTree);

    // If not found by ID/name, try CSS selector to find iframe element
    if (!frame) {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `
          (function() {
            const el = document.querySelector(${JSON.stringify(frameIdOrSelector)});
            if (!el || el.tagName !== 'IFRAME') return null;
            return el.getAttribute('name') || el.id || null;
          })()
        `,
        returnByValue: true,
      });
      if (result.result.value) {
        frame = findFrame(tree.frameTree);
      }
    }

    if (!frame) {
      console.error(`Frame not found: ${frameIdOrSelector}`);
      process.exit(1);
    }

    state.activeFrameId = frame.id;
    saveSessionState(state);
    console.log(`Switched to frame: [${frame.id}] ${frame.url}`);
  });
}

async function cmdDownload(action, ...args) {
  if (!action) action = 'path';

  const state = loadSessionState();
  const downloadDir = state.downloadDir || path.join(TMP, 'webact-downloads');

  switch (action.toLowerCase()) {
    case 'path': {
      const dir = args[0] || downloadDir;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      state.downloadDir = dir;
      saveSessionState(state);

      await withCDP(async (cdp) => {
        await cdp.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: dir,
        });
      });
      console.log(`Downloads will be saved to: ${dir}`);
      break;
    }
    case 'list': {
      if (!fs.existsSync(downloadDir)) {
        console.log('No downloads directory.');
        return;
      }
      const files = fs.readdirSync(downloadDir);
      if (files.length === 0) {
        console.log('No downloaded files.');
      } else {
        for (const f of files) {
          const stat = fs.statSync(path.join(downloadDir, f));
          const size = stat.size > 1048576 ? `${(stat.size / 1048576).toFixed(1)}MB` :
                       stat.size > 1024 ? `${(stat.size / 1024).toFixed(0)}KB` : `${stat.size}B`;
          console.log(`${f} (${size})`);
        }
      }
      break;
    }
    default:
      console.error('Usage: webact.js download [path <dir>|list]');
      process.exit(1);
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
      const selectorArg = args.filter(a => a !== '--full').join(' ') || null;
      const selector = selectorArg ? resolveSelector(selectorArg) : null;
      await cmdDom(selector, full);
      break;
    }
    case 'screenshot': await cmdScreenshot(); break;
    case 'click': await cmdClick(resolveSelector(args.join(' '))); break;
    case 'doubleclick': await cmdDoubleClick(resolveSelector(args.join(' '))); break;
    case 'hover': await cmdHover(resolveSelector(args.join(' '))); break;
    case 'focus': await cmdFocus(resolveSelector(args.join(' '))); break;
    case 'type': {
      const selector = resolveSelector(args[0]);
      const text = args.slice(1).join(' ');
      await cmdType(selector, text);
      break;
    }
    case 'keyboard': await cmdKeyboard(args.join(' ')); break;
    case 'select': await cmdSelect(resolveSelector(args[0]), ...args.slice(1)); break;
    case 'upload': await cmdUpload(resolveSelector(args[0]), ...args.slice(1)); break;
    case 'drag': await cmdDrag(resolveSelector(args[0]), resolveSelector(args[1])); break;
    case 'dialog': await cmdDialog(args[0], args.slice(1).join(' ') || undefined); break;
    case 'waitfor': await cmdWaitFor(resolveSelector(args[0]), args[1]); break;
    case 'waitfornav': await cmdWaitForNavigation(args[0]); break;
    case 'press': await cmdPress(args[0]); break;
    case 'scroll': await cmdScroll(args[0], args[1]); break;
    case 'eval': await cmdEval(args.join(' ')); break;
    case 'tabs': await cmdTabs(); break;
    case 'tab': await cmdTab(args[0]); break;
    case 'newtab': await cmdNewTab(args.join(' ') || undefined); break;
    case 'close': await cmdClose(); break;
    case 'axtree': {
      const interactive = args.includes('--interactive') || args.includes('-i');
      const selector = args.filter(a => a !== '--interactive' && a !== '-i').join(' ') || null;
      await cmdAxtree(selector, interactive);
      break;
    }
    case 'cookies': await cmdCookies(args[0], ...args.slice(1)); break;
    case 'back': await cmdBack(); break;
    case 'forward': await cmdForward(); break;
    case 'reload': await cmdReload(); break;
    case 'rightclick': await cmdRightClick(resolveSelector(args.join(' '))); break;
    case 'clear': await cmdClear(resolveSelector(args.join(' '))); break;
    case 'observe': await cmdObserve(); break;
    case 'pdf': await cmdPdf(args[0]); break;
    case 'console': await cmdConsole(args[0]); break;
    case 'block': await cmdBlock(...args); break;
    case 'viewport': await cmdViewport(args[0], args[1]); break;
    case 'frames': await cmdFrames(); break;
    case 'frame': await cmdFrame(args[0]); break;
    case 'download': await cmdDownload(args[0], ...args.slice(1)); break;
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
  back                Go back in history
  forward             Go forward in history
  reload              Reload the current page
  dom [selector]      Get compact DOM (--full for no truncation)
  axtree [selector]   Get accessibility tree (semantic roles + names)
  axtree -i           Interactive elements with ref numbers (enables ref-based targeting)
  observe             Show interactive elements as ready-to-use commands
  screenshot          Capture screenshot
  pdf [path]          Save page as PDF
  click <selector>    Click an element (waits up to 5s, scrolls into view)
  doubleclick <sel>   Double-click an element
  rightclick <sel>    Right-click an element (context menu)
  hover <selector>    Hover over an element (triggers tooltips/menus)
  focus <selector>    Focus an element without clicking
  clear <selector>    Clear an input field or contenteditable
  type <sel> <text>   Type text into element (focuses selector first)
  keyboard <text>     Type text at current caret position (no selector)
  select <sel> <val>  Select option(s) from a <select> by value or label
  upload <sel> <file> Upload file(s) to a file input
  drag <from> <to>    Drag from one element to another
  dialog <accept|dismiss> [text]  Handle alert/confirm/prompt dialog
  waitfor <sel> [ms]  Wait for element to appear (default 5000ms)
  waitfornav [ms]     Wait for page navigation to complete (default 10000ms)
  press <key>         Press a key or combo (Enter, Ctrl+A, Meta+C, etc.)
  scroll <target> [px] Scroll: up, down, top, bottom, or CSS selector [pixels]
  eval <js>           Evaluate JavaScript
  cookies [get|set|clear|delete]  Manage browser cookies
  console [show|errors|listen]    View console output or JS errors
  block <pattern>     Block requests: images, css, fonts, media, scripts, or URL
  block off           Disable request blocking
  viewport <w> <h>    Set viewport size (or preset: mobile, tablet, desktop)
  frames              List all frames/iframes on the page
  frame <id|sel>      Switch to a frame (use "frame main" to return)
  download [path|list] Set download dir or list downloaded files
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
