import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import http from 'node:http';
import { zipSync } from 'fflate';
import { packSample, SAMPLES_DIR } from '../samples/pack.js';
import { SAMPLES } from '../samples/manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serve = process.argv.includes('--serve');

// Build-time gate for the vulnerability scanner. Set PLUGINLORE_VULN_SCAN=0 to
// compile the feature out entirely (toggle hidden, detectors never run).
const vulnEnabled = process.env.PLUGINLORE_VULN_SCAN !== '0';

const outdir = join(__dirname, 'dist');
mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: !serve,          // production builds are minified; dev stays readable
  logLevel: 'info',
  define: {
    __VULN_ENABLED__: JSON.stringify(vulnEnabled),
    'process.env.NODE_ENV': '"production"',
  },
  // php-parser expects a Node-style `process` global; provide a minimal shim.
  banner: { js: 'globalThis.process=globalThis.process||{env:{},platform:"browser",argv:[],version:"",nextTick:(f)=>setTimeout(f,0)};' },
};

// Zip the companion WordPress plugin so it can be installed via Plugins → Add New → Upload.
function zipCompanion() {
  const src = join(__dirname, '..', 'companion');
  if (!existsSync(src)) return;
  const files = {};
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(src, p).split('\\').join('/')] = readFileSync(p);
    }
  })(src);
  writeFileSync(join(outdir, 'pluginlore-trace.zip'), zipSync(files, { level: 9 }));
}

// Pack every practice plugin (and its comparison version / trace) into dist/samples/.
function packSamples() {
  const dir = join(outdir, 'samples');
  mkdirSync(dir, { recursive: true });
  const dirs = new Set(SAMPLES.flatMap((s) => [s.dir, s.compare].filter(Boolean)));
  for (const d of dirs) writeFileSync(join(dir, `${d}.zip`), packSample(d));
  for (const s of SAMPLES) if (s.trace) copyFileSync(join(SAMPLES_DIR, s.trace), join(dir, s.trace));
  return dirs.size;
}

async function build() {
  // app.js + lazily-loaded chunks (the WordPress Playground client only loads when someone presses Run)
  await esbuild.build({
    ...common, entryPoints: { app: join(__dirname, 'src/main.js') }, outdir,
    splitting: true, chunkNames: 'chunks/[name]-[hash]',
  });
  await esbuild.build({ ...common, entryPoints: [join(__dirname, 'src/worker.js')], outfile: join(outdir, 'worker.js') });
  // Landing page script (tiny, no parsers) and its stylesheet (layered on style.css)
  await esbuild.build({ ...common, banner: undefined, entryPoints: [join(__dirname, 'src/landing.js')], outfile: join(outdir, 'landing.js') });
  await esbuild.build({ entryPoints: [join(__dirname, 'src/landing.css')], outfile: join(outdir, 'landing.css'), bundle: true, minify: !serve, logLevel: 'warning' });
  // CSS is bundled too, so the self-hosted fonts are copied next to it.
  await esbuild.build({
    entryPoints: [join(__dirname, 'src/style.css')], outfile: join(outdir, 'style.css'),
    bundle: true, minify: !serve, logLevel: 'warning',
    loader: { '.woff2': 'file', '.woff': 'file' }, assetNames: 'fonts/[name]-[hash]',
  });
  // The landing page is the front door; the app lives at app.html.
  copyFileSync(join(__dirname, 'landing.html'), join(outdir, 'index.html'));
  copyFileSync(join(__dirname, 'index.html'), join(outdir, 'app.html'));
  const n = packSamples();
  console.log(`Packed ${n} practice plugins into web/dist/samples`);
  zipCompanion();
  // .htaccess for shared hosting: correct MIME types.
  writeFileSync(join(outdir, '.htaccess'), 'AddType application/javascript .js\nAddType application/wasm .wasm\n');
  console.log(`\nBuilt to web/dist  (${serve ? 'dev' : 'minified'}; vuln scanner: ${vulnEnabled ? 'enabled' : 'DISABLED'})`);
}

await build();

if (serve) {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.map': 'application/json', '.zip': 'application/zip', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff' };
  http.createServer((req, res) => {
    const p = join(outdir, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(outdir) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const ext = p.slice(p.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(readFileSync(p));
  }).listen(5178, () => console.log('Dev server: http://localhost:5178'));
}
