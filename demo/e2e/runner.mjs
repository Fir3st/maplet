#!/usr/bin/env node
/**
 * Browser end-to-end runner (no npm dependencies).
 *
 * Launches a Chromium-family browser with the DevTools protocol enabled, drives
 * real input (CDP `Input` domain: mouse, wheel, keyboard) against scenario pages
 * and collects the self-reported results of the existing browser batteries.
 *
 * Everything runs against the real `dist/` build served by `demo/serve.py`, so a
 * scenario sees exactly what a consumer sees: public API calls, real pointer
 * events through the interaction controller, real GPU rendering and pixel
 * readback.
 *
 * Usage:
 *   npm run demo                      # terminal 1: static server on :8400
 *   node demo/e2e/runner.mjs          # terminal 2: all scenarios + batteries
 *   node demo/e2e/runner.mjs --list
 *   node demo/e2e/runner.mjs --scenario drag-point --verbose
 *   node demo/e2e/runner.mjs --webgpu
 *   node demo/e2e/runner.mjs --browser "/path/to/Chromium"
 *
 * Browser resolution order: --browser, $MAPLET_CHROMIUM, $CHROME_PATH, the
 * Playwright cache under ~/Library/Caches/ms-playwright, Google Chrome.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { batteries, scenarios } from './scenarios.mjs';

const BASE = process.env.MAPLET_BASE ?? 'http://localhost:8400/demo';
const args = process.argv.slice(2);
const flags = {
  list: args.includes('--list'),
  verbose: args.includes('--verbose'),
  webgpu: args.includes('--webgpu'),
  basic: args.includes('--basic'),
  keepOpen: args.includes('--keep-open'),
  scenario: valueOf('--scenario'),
  browser: valueOf('--browser'),
  base: valueOf('--base'),
  timeout: Number(valueOf('--timeout') ?? 120000),
};

/**
 * Forced "basic" WebGL 1 profile (the third GPU profile of the plan): the
 * renderer must work without `ANGLE_instanced_arrays` (CPU instance expansion),
 * with mediump fragment precision and a small `MAX_TEXTURE_SIZE`. Chromium
 * cannot disable single extensions, so the profile is forced at the API level
 * before any page script runs; the map records the fallbacks in
 * `capabilities().notes`, and the parity battery asserts them (`profile=basic`).
 */
const BASIC_PROFILE_PRELUDE = `
(() => {
  const disabled = new Set(['ANGLE_instanced_arrays', 'OES_element_index_uint', 'OES_vertex_array_object']);
  const proto = WebGLRenderingContext.prototype;
  const getExtension = proto.getExtension;
  proto.getExtension = function (name) {
    if (disabled.has(name)) return null;
    return getExtension.call(this, name);
  };
  const getShaderPrecisionFormat = proto.getShaderPrecisionFormat;
  proto.getShaderPrecisionFormat = function (shaderType, precisionType) {
    if (shaderType === this.FRAGMENT_SHADER && precisionType === this.HIGH_FLOAT) {
      return { rangeMin: 0, rangeMax: 0, precision: 0 };
    }
    return getShaderPrecisionFormat.call(this, shaderType, precisionType);
  };
  const getParameter = proto.getParameter;
  proto.getParameter = function (name) {
    const value = getParameter.call(this, name);
    if (name === this.MAX_TEXTURE_SIZE) return Math.min(value, 2048);
    return value;
  };
})();
`;

function valueOf(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function resolveBrowser() {
  const candidates = [];
  if (flags.browser) candidates.push(flags.browser);
  if (process.env.MAPLET_CHROMIUM) candidates.push(process.env.MAPLET_CHROMIUM);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  const cache = path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  try {
    for (const entry of readdirSync(cache).sort().reverse()) {
      if (entry.startsWith('chromium-') && !entry.includes('headless')) {
        candidates.push(
          path.join(cache, entry, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          path.join(cache, entry, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          path.join(cache, entry, 'chrome-linux', 'chrome'),
        );
      }
    }
  } catch {
    // no playwright cache
  }
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `no Chromium-family browser found; pass --browser <path> or set MAPLET_CHROMIUM.\nTried:\n  ${candidates.join('\n  ')}`,
  );
}

/* ------------------------------- CDP client ------------------------------- */

class Cdp {
  static async connect(url, onEvent) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(socket, onEvent);
  }

  constructor(socket, onEvent) {
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 1;
    this.sessionListeners = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      onEvent(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    this.socket.close();
  }
}

/* ------------------------------- session ---------------------------------- */

class Session {
  constructor(cdp, sessionId, name, options) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.name = name;
    this.options = options;
    this.exceptions = [];
    this.consoleErrors = [];
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`evaluate failed: ${text}\nexpression: ${expression.slice(0, 240)}`);
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 30000, label = expression) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Only a truthy value counts as ready: `false`/`undefined` means the page
      // (or the navigation) has not reached the state yet.
      const value = await this.evaluate(`(() => { try { return ${expression}; } catch { return null; } })()`);
      if (value !== null && value !== undefined && value !== false) return value;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await sleep(120);
    }
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor(
      `location.href.indexOf('http') === 0 && document.readyState === 'complete'`,
      30000,
      'document load',
    );
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  /* real input through the interaction controller */
  mouse(type, x, y, options = {}) {
    const button = options.button ?? 'left';
    const buttons = options.buttons ?? (type === 'mouseMoved' && options.dragging ? 1 : type === 'mousePressed' ? 1 : 0);
    return this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' && !options.dragging ? 'none' : button,
      buttons,
      clickCount: options.clickCount ?? (type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0),
      pointerType: 'mouse',
    });
  }

  async move(x, y) {
    await this.mouse('mouseMoved', x, y);
  }

  async click(x, y, options = {}) {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y, { clickCount: options.clickCount ?? 1 });
    await this.mouse('mouseReleased', x, y, { clickCount: options.clickCount ?? 1 });
  }

  /** Press, then move in steps, then release — one real pointer drag. */
  async drag(x, y, steps, options = {}) {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y);
    await sleep(options.settleMs ?? 90);
    let px = x;
    let py = y;
    for (const step of steps) {
      px = options.absolute ? step.x : px + step.x;
      py = options.absolute ? step.y : py + step.y;
      await this.mouse('mouseMoved', px, py, { dragging: true });
      await sleep(options.stepMs ?? 40);
    }
    await this.mouse('mouseReleased', px, py);
    await sleep(options.afterMs ?? 120);
    return { x: px, y: py };
  }

  wheel(x, y, deltaY) {
    return this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  }

  key(type, key, extra = {}) {
    return this.send('Input.dispatchKeyEvent', {
      type,
      key,
      code: extra.code ?? `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: extra.keyCode ?? 0,
      ...extra,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------ expectations ------------------------------ */

export function makeExpect(session, name) {
  const failures = [];
  const expect = {
    failures,
    ok(condition, message) {
      if (!condition) failures.push(message);
      return condition;
    },
    close(actual, expected, tolerance, message) {
      const within = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
      if (!within) failures.push(`${message}: ${actual} not within ${tolerance} of ${expected}`);
      return within;
    },
    equal(actual, expected, message) {
      if (actual !== expected) failures.push(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      return actual === expected;
    },
    async renderedPixel(x, y) {
      return session.evaluate(
        `window.__e2e.samplePixel(${Math.round(x)}, ${Math.round(y)})`,
      );
    },
  };
  return expect;
}

/* ------------------------------ run pipeline ------------------------------ */

async function runScenario(kind, definition, context) {
  const { cdp, base, options, tempDir } = context;
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.targetId;
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const session = new Session(cdp, attached.sessionId, definition.name, options);
  // Make the scenario tab the active target: a background target gets throttled
  // `requestAnimationFrame`, which would stall hover scheduling and frame
  // delivery for the page under test.
  await cdp.send('Target.activateTarget', { targetId });

  const onEvent = (message) => {
    if (message.sessionId !== session.sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      session.exceptions.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      session.consoleErrors.push(message.params.args?.map((arg) => arg.value ?? arg.description).join(' '));
    }
  };
  // Attach the event listener to the shared socket: filter by session id.
  context.events.push(onEvent);

  const started = Date.now();
  const failures = [];
  let batteryChecks = null;
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    if (options.basic) {
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source: BASIC_PROFILE_PRELUDE });
    }
    const query = [
      definition.query,
      options.webgpu ? 'backend=webgpu' : null,
      options.basic ? 'profile=basic' : null,
      `e2e=${Date.now()}`,
    ]
      .filter(Boolean)
      .join('&');
    const url = `${base}/${definition.page}?${query}`;
    await session.navigate(url);

    if (kind === 'battery') {
      const result = await session.waitFor(`window['${definition.hook}']`, options.timeout, definition.hook);
      const failedChecks = Array.isArray(result.checks)
        ? result.checks
            .filter((check) => !check.pass)
            .map((check) => `${check.name}${check.detail === undefined ? '' : ` — ${JSON.stringify(check.detail)}`}`)
        : Object.entries(result.checks ?? {})
            .filter(([, value]) => value && value.pass === false)
            .map(([key]) => key);
      failures.push(...failedChecks.map((name) => `check failed: ${name}`));
      batteryChecks = Array.isArray(result.checks) ? result.checks : null;
      if (!result.pass) {
        failures.push(
          `battery reports fail: ${(result.errors ?? []).join('; ') || failedChecks.join(', ') || 'see details fixture'}`,
        );
      }
    } else {
      await session.waitFor(definition.ready ?? 'window.__e2e && window.__e2e.ready === true', 30000, definition.ready ?? '__e2e.ready');
      const expect = makeExpect(session, definition.name);
      await definition.run({ session, expect, options, cdp });
      failures.push(...expect.failures);
    }
    if (session.exceptions.length > 0) {
      failures.push(...session.exceptions.map((text) => `uncaught: ${String(text).split('\n')[0]}`));
    }
  } catch (error) {
    failures.push(String(error.message ?? error));
  } finally {
    const index = context.events.indexOf(onEvent);
    if (index >= 0) context.events.splice(index, 1);
  }

  const ms = Date.now() - started;
  let screenshot = null;
  if (failures.length > 0 || definition.manual) {
    mkdirSync(context.checksDir, { recursive: true });
    const file = path.join(context.checksDir, `e2e-${definition.name}.png`);
    try {
      screenshot = await session.screenshot(file);
    } catch {
      screenshot = null;
    }
  }
  if (!options.keepOpen) {
    await cdp.send('Target.closeTarget', { targetId });
  }
  return { name: definition.name, kind, pass: failures.length === 0, failures, ms, screenshot, batteryChecks };
}

// Read from `demo/serve.py` so the two copies cannot drift: a running server
// from an older checkout would serve stale routes/files, so say that instead of
// failing batteries confusingly.
function readServerMarker() {
  const source = readFileSync(new URL('../serve.py', import.meta.url), 'utf8');
  const match = /^SERVER_MARKER = "([^"]+)"/m.exec(source);
  if (!match) throw new Error('demo/serve.py does not declare SERVER_MARKER');
  return match[1];
}
const SERVER_MARKER = readServerMarker();

async function ensureServer(base) {
  const probe = async () => {
    try {
      const response = await fetch(`${base}/e2e/scene.html`, { method: 'GET' });
      return response.ok ? response : false;
    } catch {
      return false;
    }
  };
  const running = await probe();
  if (running) {
    const marker = running.headers.get('x-maplet-serve');
    if (marker !== SERVER_MARKER) {
      throw new Error(
        `the demo server on ${base} is stale (X-Maplet-Serve: ${marker ?? 'missing'}, expected ${SERVER_MARKER}); ` +
          'stop it and run "npm run e2e" again so the runner starts the current demo/serve.py',
      );
    }
    return null;
  }
  console.log(`starting demo server (python3 demo/serve.py) for ${base} ...`);
  const server = spawn('python3', ['demo/serve.py'], { stdio: 'ignore', detached: false });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (await probe()) return server;
  }
  server.kill('SIGKILL');
  throw new Error(`no server at ${base}; run "npm run demo" in another terminal`);
}

async function main() {
  if (flags.webgpu && flags.basic) {
    console.error('--webgpu and --basic are mutually exclusive: --basic forces the fallback WebGL 1 profile');
    return 1;
  }
  const list = [...scenarios.map((scenario) => ({ kind: 'scenario', ...scenario })), ...batteries.map((battery) => ({ kind: 'battery', ...battery }))];
  if (flags.list) {
    for (const entry of list) console.log(`${entry.kind.padEnd(9)} ${entry.name}`);
    return 0;
  }
  const selected = flags.scenario
    ? list.filter((entry) => entry.name === flags.scenario)
    : list.filter((entry) => !entry.manual);
  if (selected.length === 0) {
    console.error(`no scenario named ${flags.scenario}; use --list`);
    return 1;
  }

  const base = flags.base ?? BASE;
  const server = await ensureServer(base);
  const browser = resolveBrowser();
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'maplet-e2e-'));
  const browserArgs = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    // Never touch the macOS Keychain. A freshly installed Playwright browser
    // asks for access to its "Chrome Safe Storage" item on every launch until
    // the ACL is granted, and these tests have no use for encrypted cookie or
    // password storage: a mock keychain removes the prompt entirely.
    '--use-mock-keychain',
    '--password-store=basic',
    // Keep the page "foreground": headless Chromium otherwise throttles
    // requestAnimationFrame to ~1 Hz in some runs (measured 1016 ms frames),
    // which makes every frame-cadence check flaky.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=900,700',
    // The soak battery measures GC-stabilized heap deltas (create/destroy
    // cycles, releasing a 500k store): `--expose-gc` gives it `gc()` and
    // `--enable-precise-memory-info` un-quantizes `performance.memory`.
    '--js-flags=--expose-gc',
    '--enable-precise-memory-info',
  ];
  if (flags.webgpu) {
    browserArgs.push('--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU');
  }
  const child = spawn(browser, browserArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let wsUrl = null;
  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    stderrTail = (stderrTail + text).slice(-4000);
    const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) wsUrl = match[1];
  });
  child.on('exit', (code) => {
    if (!wsUrl) console.error(`browser exited early (${code})\n${stderrTail}`);
  });

  const deadline = Date.now() + 20000;
  while (!wsUrl && Date.now() < deadline) await sleep(100);
  if (!wsUrl) {
    console.error(`browser did not expose a DevTools endpoint\n${stderrTail}`);
    child.kill('SIGKILL');
    return 1;
  }

  const events = [];
  const cdp = await Cdp.connect(wsUrl, (message) => {
    for (const listener of events) listener(message);
  });
  const context = {
    cdp,
    events,
    base,
    options: flags,
    checksDir: path.join(process.cwd(), 'demo', 'checks'),
    tempDir: userDataDir,
  };

  console.log(`browser: ${browser}`);
  console.log(`mode:    ${flags.webgpu ? 'webgpu' : flags.basic ? 'webgl1-basic (no ANGLE instancing, mediump fragments)' : 'webgl1'}`);
  console.log(`base:    ${context.base}`);
  console.log('');

  const results = [];
  for (const entry of selected) {
    process.stdout.write(`· ${entry.name}`.padEnd(48));
    const result = await runScenario(entry.kind, entry, context);
    results.push(result);
    const label = result.pass ? 'PASS' : 'FAIL';
    console.log(`${label}  ${String(result.ms).padStart(6)} ms`);
    if (result.failures.length > 0 || flags.verbose) {
      for (const failure of result.failures) console.log(`    ${failure}`);
      if (flags.verbose && result.batteryChecks) {
        for (const check of result.batteryChecks) {
          console.log(`    ${check.pass ? 'ok  ' : 'FAIL'} ${check.name}${check.detail === undefined ? '' : ` — ${JSON.stringify(check.detail)}`}`);
        }
      }
      if (result.screenshot) console.log(`    screenshot: ${result.screenshot}`);
    }
  }

  const failed = results.filter((result) => !result.pass);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} scenarios pass`);
  cdp.close();
  if (!flags.keepOpen) child.kill('SIGTERM');
  server?.kill('SIGTERM');
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
