// Runs plugin code for real, inside WordPress Playground: WordPress and PHP
// compiled to WebAssembly, running in a hidden sandboxed frame in this browser
// tab. The plugin's files never leave the browser; the runtime itself is
// downloaded from playground.wordpress.net the first time (then cached).
// Outbound network from PHP is switched off, so plugin code can't call home.

import { CONTENT, activateScript, callScript, parseResult } from './harness.js';

const REMOTE = 'https://playground.wordpress.net/remote.html';
const BOOT_TIMEOUT = 180000;
const CALL_TIMEOUT = 25000;

const withTimeout = (p, ms, msg) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(msg), { timeout: true })), ms)),
]);

export class Runner {
  constructor() {
    this.client = null;
    this.iframe = null;
    this.booting = null;
    this.installedKey = null;
    this.installResult = null;
  }

  get ready() { return !!this.client; }

  // Start WordPress in the browser (once). onProgress({ loaded, total }).
  async boot(onProgress = () => {}) {
    if (this.client) return this.client;
    if (!this.booting) {
      this.booting = (async () => {
        const { startPlaygroundWeb } = await import('@wp-playground/client');
        const iframe = document.createElement('iframe');
        iframe.title = 'Pluginlore sandbox (WordPress Playground)';
        iframe.className = 'sl-sandbox';
        iframe.setAttribute('aria-hidden', 'true');
        iframe.tabIndex = -1;
        document.body.appendChild(iframe);
        this.iframe = iframe;
        const client = await withTimeout(startPlaygroundWeb({
          iframe,
          remoteUrl: REMOTE,
          disableProgressBar: true,
          blueprint: {
            preferredVersions: { php: '8.3', wp: 'latest' },
            features: { networking: false },
            steps: [{ step: 'login', username: 'admin' }],
          },
          onClientConnected: (c) => { try { c.onDownloadProgress((e) => onProgress(e.detail || {})); } catch { /* optional */ } },
        }), BOOT_TIMEOUT, 'Starting WordPress took too long. Check your connection and try again.');
        await client.isReady();
        this.client = client;
        return client;
      })();
    }
    try { return await this.booting; }
    catch (err) { this.reset(); throw err; }
    finally { this.booting = null; }
  }

  // Install a package (or a whole site's packages) and activate it. `key`
  // identifies what's installed so re-running a function doesn't reinstall.
  async install(key, packages) {
    if (this.installedKey === key) return this.installResult;
    const c = this.client;
    const plugins = [];
    let theme = null;
    for (const pkg of packages) {
      const base = `${CONTENT}${pkg.kind === 'theme' ? 'themes' : 'plugins'}/${pkg.dir}`;
      const dirs = new Set();
      for (const f of pkg.files) {
        const full = `${base}/${f.path}`;
        const dir = full.slice(0, full.lastIndexOf('/'));
        if (!dirs.has(dir)) { await c.mkdir(dir); dirs.add(dir); }
        await c.writeFile(full, f.bytes);
      }
      if (pkg.kind === 'theme') theme = pkg.dir;
      else if (pkg.main) plugins.push(`${pkg.dir}/${pkg.main}`);
    }
    const res = await withTimeout(c.run({ code: activateScript({ kind: 'mixed', plugins, theme }) }), CALL_TIMEOUT, 'Activating the plugin took too long.');
    const { result, stray } = parseResult(res.text);
    this.installResult = {
      activated: (result && result.activated) || [],
      errors: [...((result && result.errors) || []), ...(!result ? [firstLine(res.errors || stray || 'Activation failed.')] : [])],
    };
    this.installedKey = key;
    return this.installResult;
  }

  // Call one function. Times out (and resets the sandbox) if it hangs.
  async call(opts) {
    let res;
    try {
      res = await withTimeout(this.client.run({ code: callScript(opts) }), CALL_TIMEOUT, 'The function ran for more than 25 seconds, so it was stopped and the sandbox was reset.');
    } catch (err) {
      if (err.timeout) this.reset();
      throw err;
    }
    const { result, stray } = parseResult(res.text);
    return { result, stray: stray.trim(), phpErrors: res.errors, exitCode: res.exitCode };
  }

  reset() {
    if (this.iframe) this.iframe.remove();
    this.iframe = null;
    this.client = null;
    this.installedKey = null;
    this.installResult = null;
  }
}

function firstLine(s) { return String(s).split('\n').find((l) => l.trim()) || 'Unknown error'; }
