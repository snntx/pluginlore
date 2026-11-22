# Pluginlore

**See how a WordPress plugin or theme works: an interactive map, a plain-English walkthrough, and a security audit, all in your browser.**

Drop in a `.zip` and Pluginlore parses every PHP and JS file, draws how they connect, audits who can call each request handler, compares versions, and exports a client-ready report. In the web app, the zip never leaves the browser. Analysis only *reads* code. Nothing runs unless you press **Run** on a function, and then it runs inside a WordPress sandbox in your own browser tab (see below).

---

## Features

### See the structure
- **Real parsers**: PHP via `php-parser`, JavaScript via `acorn` - not regex.
- **Relationship graph** with distinct line styles: includes, inheritance (with override detection), interfaces, traits, function calls, WordPress hooks, JS → AJAX, JS → REST, enqueues, and JS ↔ DOM (a script's `#id`/`.class` lookups linked to the PHP that renders them).
- **php / js / css file icons**, ringed by reachability: unauthenticated entry, REST, logged-in entry, internal, orphan, asset. Nodes never overlap.
- **Two views of the same graph.** **Web** clusters files by folder; labels are placed most-important-first and skipped rather than overlapped, and every file gets a box that includes its label so nothing sits on top of anything else. **Flow** is a left-to-right flow chart: entry points first, then what they load and call, with labelled cards and curved links (tall columns wrap; it opens at a readable zoom and scrolls like a page). Switching morphs smoothly between the two.
- **Less noise by default.** Unconnected files are tucked away (public files and files with findings always stay), and selecting a file spotlights it and its direct links. macOS zip clutter (`__MACOSX/`, `._file` stubs, `.DS_Store`), VCS/editor folders and `node_modules` are ignored at load time.
- **Signal simulation**: ping any file (including a front-end JS file) and watch the signal spread level by level through every reachable file, once. The lit path holds briefly, then fades and resets on its own; **Stop signal** (or Esc) ends it at any time. Reports reach, paths, dead ends and sinks on the way.

### Audit it
- **Access-control audit** - every AJAX, admin-post and REST handler, with yes/no for capability check, login check and nonce check, and whether it changes data (options, posts, users, files, `$wpdb` writes, roles…). Follows the handler into helpers it calls, handles closures and REST `permission_callback`s. Missing authorization (CWE-862) and CSRF (CWE-352) are the most common real WordPress plugin vulnerabilities.
- **Vulnerability patterns** (opt-in, behind a disclaimer) - SQLi, command/code injection, object injection, path traversal, reflected XSS, with intra-function taint tracking.
- **Performance hints** - database queries, `WP_Query`, HTTP requests inside loops (N+1), unbounded `posts_per_page => -1`.
- **Whole-site scan** - drop a folder of several plugins/themes: each package is detected and clustered, and **duplicate global functions/classes** that would fatal ("Cannot redeclare") are flagged, while `function_exists()`-guarded ones are recognised as safe.

### Track change
- **Version diff** - drop a second version. Pluginlore orders them by the `Version:` header and shows new/removed entry points, auth changes, **access regressions** (a capability or nonce check disappeared) and **possible silent security fixes** (a finding vanished from a changed file - how patched vulnerabilities are usually spotted). The graph marks added (+) and changed (~) files.
- **Runtime trace** - install the bundled **Pluginlore Trace** plugin on a *local* test site, use the site, export the trace and import it. Files that really loaded get a green pip; the Runtime tab lists handlers your testing never exercised.

### Share it
- **Report export** - standalone HTML (or print to PDF) with your agency name, client, logo and notes: summary, structure map, access table, findings, duplicates, version changes, runtime coverage, and a methodology/limitations section.
- **CLI + CI** - SARIF output for GitHub Code Scanning, `--fail-on` severity gates, and `diff --fail-on-regression`.

### Learn it
- **Learn tab** - a guided walkthrough of the plugin in the order WordPress runs it: how WordPress finds it and what it loads, activation and uninstall, what it sets up on every request, what visitors see, the admin area, every request it answers (and which JavaScript sends it), background jobs, hooks it offers other developers, and the data it keeps. Then every file and every function explained in plain English: what it does, what triggers it, who calls it, and for each argument what it is and a sensible value to try. Dotted words open a glossary; **Show in graph** lights up the files involved; **Follow the signal** sends a wave from that file. Generated from the code's structure, not by AI.
- **Run a function** - every PHP function in the Learn tab has a **Run** button. It starts [WordPress Playground](https://wordpress.github.io/wordpress-playground/) (WordPress and PHP compiled to WebAssembly) in a hidden frame, installs and activates the plugin, and calls the function with the arguments you type. Arguments and request input (`$_POST`, `$_GET`, `$_COOKIE` keys the function reads) come pre-filled from the hints. You choose who runs it (logged-out visitor, subscriber, administrator) and can pretend nonce checks pass. The result shows what it returned, what it printed (with a sandboxed preview), whether it stopped via `wp_die()`/`exit`, PHP warnings, files it loaded, and **step by step** every hook that ran plugin code during the call, with the file each callback lives in. The plugin's files stay in the browser; the Playground runtime (~35 MB) is downloaded from playground.wordpress.net the first time and then cached. PHP's outbound network is switched off. A call that runs past 25 seconds is stopped and the sandbox reset.
- **Load from WordPress.org** - search the plugin or theme directory, pick any version back to the first release, or two versions to compare. The browser downloads the zip straight from WordPress.org (only the name you search leaves your machine).
- **Practice plugins** - eight small tutorial plugins, each built to demonstrate one scenario, loadable with one click (no zip needed) and each with a short list of "missions":

  | Plugin | What it teaches |
  |---|---|
  | Leaky Contact Form | Broken access control: no nonce, no capability check, a public destructive REST route, plus SQLi and XSS |
  | Tangled Shop | JS → PHP: `$.post`, `fetch` REST, a FormData fallback, DOM lookups linked to rendered markup |
  | Class Zoo | Interfaces, traits, inheritance with overrides, an orphan file, a directly-requestable file |
  | Slowpoke Gallery | N+1 queries, `WP_Query` and HTTP requests in loops, unbounded queries |
  | Version Drama 1.4.0 → 1.5.0 | A silent fix, a removed capability check and a new public endpoint |
  | Crowded Site | Two plugins and a theme with fatal "Cannot redeclare" clashes, and one safely guarded copy |
  | Runtime Replay | Leaky Contact Form plus a recorded session: which risky handlers were never exercised |
  | Tidy Newsletter | The well-behaved one, for contrast |

  They live in `samples/` with a manifest; `npm test` proves every one of them triggers the scenario it claims. Missions **tick themselves off** as you do them (each has a `when` rule matched against UI events), and the tests also prove every mission can actually be completed.
- **First-run tour** - a spotlight walkthrough (keyboard friendly; replay any time from **Tour**).
- **Live loading screen** - shows the file actually being read, the current phase, and a progress bar that eases smoothly toward the worker's real progress.

### About the security results

They are **heuristics, not proof**. Expect false positives; a clean scan does not mean the code is safe. Access checks detect the *presence* of capability/nonce calls, not that they are correctly enforced. The vulnerability scan is off by default, gated behind an in-app disclaimer, and can be compiled out entirely (`PLUGINLORE_VULN_SCAN=0`). Only test software you are authorised to test.

---

## Web app

```bash
npm install
npm run dev:web          # build + serve at http://localhost:5178
npm run build:web        # minified static build in web/dist/
```

The build writes the landing page to `web/dist/index.html` and the app to `web/dist/app.html` (`app.html#practice` opens the practice plugins, `#wporg` the WordPress.org search). Donation and source links for both live in `web/src/links.js`.

`web/dist/` is fully static - host it anywhere (shared hosting, Cloudflare Pages, Netlify, Railway). It includes `pluginlore-trace.zip`, the companion plugin, which the app links to.

```bash
PLUGINLORE_VULN_SCAN=0 npm run build:web   # ship without the vulnerability scanner
```

## CLI

```bash
node src/cli/index.js <plugin.zip | directory> [--php 8.2] [--vuln] \
  [--json out.json] [--sarif out.sarif] [--path-prefix wp-content/plugins/my-plugin] \
  [--simulate path/in/package.php] [--fail-on high]

node src/cli/index.js diff <old.zip|dir> <new.zip|dir> [--json diff.json] [--fail-on-regression]
```

### GitHub Actions example

```yaml
- run: npx pluginlore . --vuln --sarif pluginlore.sarif --fail-on high
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: pluginlore.sarif }
```

## Runtime trace (companion plugin)

1. On a **local development** site, install `pluginlore-trace.zip` (Plugins → Add New → Upload).
2. Add `define( 'PLUGINLORE_TRACE', true );` to `wp-config.php`. Nothing is recorded without it.
3. Use the site, then Tools → Pluginlore Trace → **Download trace**.
4. In Pluginlore, load the same plugin zip and use **Runtime trace → Import**.

The log stays in that site's database (never autoloaded, capped at 500 requests) until you download or clear it. Nothing is sent anywhere.

## Project layout

```
src/core/        shared engine (runs in Node and in the browser worker)
  ingest.js        safe zip extraction (path-traversal + zip-bomb guards)
  analyze.js       AST → nodes/edges, reachability, detectors, perf hints
  access.js        access-control audit (capability / login / nonce / writes)
  site.js          package detection + duplicate-declaration conflicts
  diff.js          version comparison
  trace.js         runtime-trace matching
  sarif.js         SARIF 2.1.0 export
  wp.js            WordPress facts: registrations, function summaries, argument hints
  simulate.js      static path tracing (BFS levels for the wave animation)
  js-analyze.js    JS → AJAX/REST/DOM extraction
  probes.js        curl probe generation (text only)
  php-deprecated.js / vuln-rules.js / styles.js   extendable data files
src/cli/         command-line wrapper
web/             static front-end (canvas graph, tables, report, worker)
  src/runner.js    WordPress Playground sandbox (loaded only when you press Run)
  src/harness.js   PHP that activates the plugin and calls one function, with a hook tracer
companion/       Pluginlore Trace WordPress plugin (dev-only)
samples/         practice plugins + manifest.js (+ pack.js, shared by build and tests)
test/            node:test suite + fixtures (npm test)
```

## Limitations

- Static analysis over-approximates: dynamic includes, variable function names and reflection can't be fully resolved.
- Taint tracking is intra-function; it won't follow data across files or through the database.
- Handler resolution matches by function/method name; two classes with the same method name can be confused.
- JS linking resolves statically written URLs/actions/paths (plus `FormData`/`action` fallbacks); runtime-built values may not resolve. Minified JS is listed but not parsed.
- **Run** calls one function in a fresh WordPress with no content of its own beyond what activation creates; functions that expect a specific post, order or setting may need you to pass IDs that exist there. Classes not loaded at startup (autoloaded only on demand by unusual loaders) may not be callable directly. Instance methods are called on a new object (constructor skipped if it needs arguments).
- Deprecation and vulnerability data are curated starter lists in plain data files.

## License

GPL-2.0-or-later (see `LICENSE`). Pluginlore is free software: you can use, change and share it, and anything you distribute that's built from it must stay under the same license with its source available. This matches WordPress itself and WordPress Playground, which the web app bundles.

Pluginlore is free forever and funded by donations (Buy Me a Coffee); the GPL allows that.

### Third-party services

- **WordPress Playground** (`@wp-playground/client`, GPL-2.0-or-later) runs a function only when you press **Run**. The runtime loads from `playground.wordpress.net` / `wasm.wordpress.net`, so those servers see your IP address like any website does; see the [WordPress.org privacy policy](https://wordpress.org/about/privacy/). The plugin's files are never uploaded. WordPress.org hosts Playground for the community with no uptime guarantee; for a production deploy, self-host it ([guide](https://developer.wordpress.org/playground/developers/architecture/host-your-own-playground)) and set `remoteUrl`.
- **WordPress.org API** is called only when you use **Load from WordPress.org** (your search text, then the zip download).

## Deploy on shared hosting (cPanel / Namecheap)

```bash
npm ci
npm run pack:web        # builds, then writes web/pluginlore-site.zip (no source maps)
```

In cPanel: File Manager, open the domain's folder (usually `public_html`), delete any default `index.php` or `index.html` left by the host, upload `pluginlore-site.zip` and choose Extract. Switch on the free SSL certificate (AutoSSL) so the HTTPS redirect in `.htaccess` works. The landing page is `/` and the app is `/app.html`.
