// WordPress.org directory client. api.wordpress.org and downloads.wordpress.org
// both send `Access-Control-Allow-Origin: *`, so the browser talks to them
// directly: no proxy, no Pluginlore server. Only the search text / slug leaves
// the machine, and the zip comes straight from WordPress.org.

const API = 'https://api.wordpress.org';
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;
// Only ever download real directory zips, whatever the API response says.
const DOWNLOAD_RE = /^https:\/\/downloads\.wordpress\.org\/(plugin|theme)\/[a-z0-9][a-z0-9._-]*\.zip$/i;
const MAX_BYTES = 80 * 1024 * 1024;

const q = (params) => Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

async function getJson(url, signal) {
  const res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`WordPress.org answered ${res.status}`);
  return res.json();
}

// Search the plugin or theme directory. Returns light result objects.
export async function search(kind, text, signal) {
  const term = String(text || '').trim();
  if (!term) return [];
  if (kind === 'theme') {
    const data = await getJson(`${API}/themes/info/1.2/?${q({
      action: 'query_themes', 'request[search]': term, 'request[per_page]': 10,
    })}`, signal);
    return (data.themes || []).map((t) => ({
      kind, slug: t.slug, name: t.name, version: t.version,
      blurb: stripTags(t.description || '').slice(0, 160), icon: t.screenshot_url || null,
      installs: null, rating: t.rating, requiresPhp: t.requires_php || null,
    }));
  }
  const data = await getJson(`${API}/plugins/info/1.2/?${q({
    action: 'query_plugins', 'request[search]': term, 'request[per_page]': 10,
    'request[fields][short_description]': 1, 'request[fields][icons]': 1, 'request[fields][description]': 0,
    'request[fields][sections]': 0, 'request[fields][reviews]': 0, 'request[fields][versions]': 0,
    'request[fields][screenshots]': 0, 'request[fields][tags]': 0, 'request[fields][contributors]': 0,
  })}`, signal);
  return (data.plugins || []).map((p) => ({
    kind, slug: p.slug, name: p.name, version: p.version,
    blurb: stripTags(p.short_description || ''), icon: (p.icons && (p.icons['1x'] || p.icons.svg || p.icons.default)) || null,
    installs: p.active_installs, rating: p.rating, requiresPhp: p.requires_php || null,
  }));
}

// Full details for one slug, including every downloadable version (newest first).
export async function details(kind, slug, signal) {
  if (!SLUG_RE.test(slug)) throw new Error('That does not look like a WordPress.org slug.');
  const base = kind === 'theme' ? 'themes' : 'plugins';
  const action = kind === 'theme' ? 'theme_information' : 'plugin_information';
  const data = await getJson(`${API}/${base}/info/1.2/?${q({
    action, 'request[slug]': slug, 'request[fields][versions]': 1,
    'request[fields][sections]': 0, 'request[fields][reviews]': 0, 'request[fields][description]': 0,
    'request[fields][screenshots]': 0, 'request[fields][contributors]': 0,
  })}`, signal);
  if (!data || data.error || !data.slug) throw new Error(`No ${kind} called "${slug}" on WordPress.org.`);
  const versions = Object.entries(data.versions || {})
    .filter(([, url]) => DOWNLOAD_RE.test(url))
    .map(([version, url]) => ({ version, url }))
    .sort((a, b) => (a.version === 'trunk') - (b.version === 'trunk') || compareVersions(b.version, a.version));
  if (DOWNLOAD_RE.test(data.download_link || '') && !versions.some((v) => v.url === data.download_link)) {
    versions.unshift({ version: data.version, url: data.download_link });
  }
  return {
    kind, slug: data.slug, name: data.name, version: data.version, versions,
    requiresPhp: data.requires_php || null, requires: data.requires || null, tested: data.tested || null,
    installs: data.active_installs ?? null, author: stripTags(typeof data.author === 'string' ? data.author : data.author?.display_name || ''),
    lastUpdated: data.last_updated || null,
  };
}

// Download a directory zip with progress. Refuses anything that isn't a
// downloads.wordpress.org zip, and anything over 80 MB.
export async function download(url, onProgress, signal) {
  if (!DOWNLOAD_RE.test(url)) throw new Error('Refusing to download from outside downloads.wordpress.org.');
  const res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (total > MAX_BYTES) throw new Error('This download is larger than 80 MB.');
  if (!res.body || !res.body.getReader) {
    const buf = await res.arrayBuffer();
    onProgress && onProgress(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > MAX_BYTES) { reader.cancel(); throw new Error('This download is larger than 80 MB.'); }
    chunks.push(value);
    onProgress && onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
}

export function isDownloadUrl(url) { return DOWNLOAD_RE.test(url); }

function stripTags(s) { return String(s).replace(/<[^>]*>/g, '').trim(); }

export function compareVersions(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
