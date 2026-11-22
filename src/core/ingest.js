import { unzipSync, strFromU8 } from 'fflate';

// Text extensions we read into the analyzer. Everything else is listed but not
// decoded (binaries never parsed).
const TEXT_RE = /\.(php|phtml|inc|js|mjs|cjs|jsx|ts|css|json|txt|md|html?|xml|ya?ml|ini|htaccess)$/i;
const PARSE_RE = /\.(php|phtml|inc|js|mjs|cjs|jsx)$/i;

// Files that are never part of a package: macOS zip metadata (__MACOSX/,
// AppleDouble "._name" stubs), OS clutter, VCS/editor folders, node_modules.
const JUNK_SEGMENTS = new Set(['__MACOSX', '.git', '.svn', '.hg', '.idea', '.vscode', 'node_modules']);
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);

// Returns a reason string when `path` is junk, otherwise null.
export function junkReason(path) {
  const segs = String(path).replace(/\\/g, '/').split('/').filter(Boolean);
  for (const s of segs.slice(0, -1)) {
    if (s === '__MACOSX') return 'macOS metadata';
    if (JUNK_SEGMENTS.has(s)) return s === 'node_modules' ? 'node_modules' : 'version control / editor';
  }
  const base = segs[segs.length - 1] || '';
  if (base.startsWith('._')) return 'macOS metadata';
  if (JUNK_FILES.has(base)) return 'OS clutter';
  return null;
}

const DEFAULTS = {
  maxFiles: 20000,
  maxFileBytes: 5 * 1024 * 1024,      // 5 MB per file
  maxTotalBytes: 300 * 1024 * 1024,   // 300 MB uncompressed total (bomb guard)
};

// `data`: Uint8Array of a .zip. Returns { files, skipped, root, warnings }.
export function ingestZip(data, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const warnings = [];
  const skipped = [];
  let total = 0;
  let count = 0;
  const ignored = { total: 0, byReason: {} };

  const onProgress = options.onProgress || null;
  const raw = unzipSync(data, {
    filter(file) {
      if (file.name.endsWith('/')) return false; // directories
      const junk = junkReason(file.name);
      if (junk) { ignored.total++; ignored.byReason[junk] = (ignored.byReason[junk] || 0) + 1; return false; }
      count++;
      if (onProgress) onProgress({ phase: 'unzip', i: count, file: file.name });
      if (count > o.maxFiles) { warnings.push(`Stopped at ${o.maxFiles} files.`); return false; }
      // Path traversal / absolute paths: refuse outright.
      if (file.name.includes('..') || file.name.startsWith('/') || /^[a-zA-Z]:/.test(file.name)) {
        skipped.push({ name: file.name, reason: 'unsafe path' });
        return false;
      }
      if (file.originalSize > o.maxFileBytes) {
        skipped.push({ name: file.name, reason: `too large (${fmt(file.originalSize)})` });
        return false;
      }
      total += file.originalSize;
      if (total > o.maxTotalBytes) {
        warnings.push(`Uncompressed size exceeded ${fmt(o.maxTotalBytes)} - remaining files skipped (possible zip bomb).`);
        return false;
      }
      return true;
    },
  });

  const entries = Object.entries(raw);
  const root = commonRoot(entries.map(([name]) => name));

  const files = [];
  for (const [name, bytes] of entries) {
    const path = stripRoot(name, root);
    if (!path) continue;
    if (TEXT_RE.test(path) && !looksBinary(bytes)) {
      files.push({ path, content: strFromU8(bytes), bytes: bytes.length, parse: PARSE_RE.test(path) });
    } else {
      files.push({ path, content: '', bytes: bytes.length, binary: true });
    }
  }

  return { files, skipped, root, warnings, ignored };
}

export function commonRoot(names) {
  if (names.length === 0) return '';
  const segs = names[0].split('/').slice(0, -1);
  let prefix = segs;
  for (const n of names) {
    const parts = n.split('/').slice(0, -1);
    let i = 0;
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  // Only treat as a wrapping root if EVERY entry sits under it.
  const candidate = prefix.join('/');
  if (candidate && names.every((n) => n.startsWith(candidate + '/'))) return candidate;
  return '';
}

function stripRoot(name, root) {
  if (root && name.startsWith(root + '/')) return name.slice(root.length + 1);
  return name;
}

function looksBinary(bytes) {
  const n = Math.min(bytes.length, 512);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function fmt(b) {
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b > 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return b + ' B';
}

// Every real file in the archive as raw bytes (junk and unsafe paths dropped,
// wrapping folder stripped): what gets installed into the in-browser WordPress.
export function extractFiles(data, options = {}) {
  const o = { ...DEFAULTS, ...options };
  let total = 0;
  const raw = unzipSync(data, {
    filter(file) {
      if (file.name.endsWith('/') || junkReason(file.name)) return false;
      if (file.name.includes('..') || file.name.startsWith('/') || /^[a-zA-Z]:/.test(file.name)) return false;
      if (file.originalSize > o.maxFileBytes) return false;
      total += file.originalSize;
      return total <= o.maxTotalBytes;
    },
  });
  const names = Object.keys(raw);
  const root = commonRoot(names);
  return {
    root,
    files: names.map((name) => ({ path: stripRoot(name, root), bytes: raw[name] })).filter((f) => f.path),
  };
}
