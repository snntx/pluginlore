// Builds a standalone, print-friendly HTML audit report (white-label capable).
// Everything is inlined, so the file can be emailed or saved as PDF.

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4, ok: 5 };
const KIND_LABEL = { vuln: 'Vulnerability pattern', access: 'Access control', deprecated: 'Deprecated PHP', perf: 'Performance', conflict: 'Duplicate declaration' };

export function buildReport({ model, diff, trace, branding = {}, sections = {}, graphPng }) {
  const m = model.meta, s = model.stats;
  const want = (k) => sections[k] !== false;
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const title = `${m.packageName || 'PHP package'}${m.packageVersion ? ' ' + m.packageVersion : ''}`;
  const findings = model.nodes.flatMap((n) => n.issues.map((i) => ({ file: n.path, ...i })))
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  const accessBad = (model.access || []).filter((a) => ['high', 'medium'].includes(a.severity));
  // handlers anyone can call without logging in (matches the summary bullet)
  const publicEntries = (model.access || []).filter((a) => a.auth === 'unauth').length;

  const parts = [];
  parts.push(`
  <header class="cover">
    <div class="brandline">
      ${branding.logo ? `<img class="logo" src="${branding.logo}" alt="">` : ''}
      <div>
        ${branding.agency ? `<div class="agency">${esc(branding.agency)}</div>` : ''}
        <div class="muted">Static code review · ${esc(date)}</div>
      </div>
    </div>
    <h1>${esc(title)}</h1>
    <div class="meta-grid">
      ${row('Prepared for', branding.client || '-')}
      ${row('Package type', m.packageType)}
      ${row('Files analysed', `${m.fileCount} PHP · ${m.jsCount || 0} JS · ${m.totalFiles} total`)}
      ${row('Vulnerability scan', m.vulnScan ? 'Enabled (heuristic)' : 'Not enabled')}
    </div>
  </header>`);

  if (want('summary')) {
    parts.push(`
    <section>
      <h2>Summary</h2>
      <div class="cards">
        ${card(publicEntries, 'handlers callable without login', publicEntries ? 'warn' : '')}
        ${m.vulnScan ? card(accessBad.length, 'access-control issues', accessBad.length ? 'bad' : 'good') : ''}
        ${m.vulnScan ? card(s.vuln, 'vulnerability patterns', s.vuln ? 'bad' : 'good') : ''}
        ${card(s.perf, 'performance hints', s.perf ? 'warn' : 'good')}
        ${card(s.conflictsHigh || 0, 'fatal-risk duplicates', s.conflictsHigh ? 'bad' : 'good')}
      </div>
      <ul class="bullets">${summaryBullets(model, diff, trace).map((b) => `<li>${b}</li>`).join('')}</ul>
      ${branding.notes ? `<div class="notes"><h3>Reviewer notes</h3><p>${esc(branding.notes).replace(/\n/g, '<br>')}</p></div>` : ''}
    </section>`);
  }

  if (want('graph') && graphPng) {
    parts.push(`<section class="break"><h2>Structure map</h2><p class="muted">Files and how they connect. Ringed nodes are publicly reachable; red dots mark findings.</p><img class="graph" src="${graphPng}" alt="Dependency graph"></section>`);
  }

  if (want('access') && (model.access || []).length) {
    parts.push(`
    <section class="break">
      <h2>Access control</h2>
      <p class="muted">Every AJAX, admin-post and REST handler, and whether it checks the user's capability and a nonce before acting.</p>
      <table>
        <thead><tr><th>${m.vulnScan ? 'Risk' : ''}</th><th>Endpoint</th><th>Who can call</th><th>Capability</th><th>Nonce</th><th>Changes data</th><th>Assessment</th></tr></thead>
        <tbody>${[...model.access].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)).map((a) => `
          <tr>
            <td>${m.vulnScan ? sev(a.severity) : ''}</td>
            <td><code>${esc(a.name)}</code><div class="muted small">${esc(a.file)}:${a.line}</div></td>
            <td>${a.type === 'rest' ? `REST (${esc(a.permission || '?')})` : a.auth === 'unauth' ? 'Anyone' : 'Logged-in users'}</td>
            <td>${tick(a.cap)}</td><td>${tick(a.nonce)}</td>
            <td>${a.writes.length ? esc(a.writes.join(', ')) : '-'}</td>
            <td>${m.vulnScan ? esc(a.message) : '-'}</td>
          </tr>`).join('')}</tbody>
      </table>
    </section>`);
  }

  if (want('findings') && findings.length) {
    parts.push(`
    <section class="break">
      <h2>Findings (${findings.length})</h2>
      <table>
        <thead><tr><th>Severity</th><th>Type</th><th>Location</th><th>Detail</th></tr></thead>
        <tbody>${findings.map((f) => `
          <tr><td>${sev(f.severity)}</td><td>${esc(KIND_LABEL[f.kind] || f.kind)}${f.cwe ? `<div class="muted small">${esc(f.cwe)}</div>` : ''}</td>
          <td><code>${esc(f.file)}:${f.line}</code></td><td>${esc(f.message)}</td></tr>`).join('')}</tbody>
      </table>
    </section>`);
  }

  if (want('conflicts') && (model.conflicts || []).length) {
    parts.push(`
    <section class="break">
      <h2>Duplicate declarations</h2>
      ${m.packages && m.packages.length > 1 ? `<p class="muted">Packages in this archive: ${m.packages.map((p) => `${esc(p.name)} ${esc(p.version || '')}`).join(', ')}</p>` : ''}
      <table><thead><tr><th>Risk</th><th>Symbol</th><th>Declared in</th></tr></thead>
      <tbody>${model.conflicts.map((c) => `<tr><td>${sev(c.severity)}</td><td><code>${esc(c.name)}</code><div class="muted small">${esc(c.message)}</div></td>
        <td>${c.locations.map((l) => `<code>${esc(l.file)}:${l.line}</code>${l.guarded ? ' <span class="muted">(guarded)</span>' : ''}`).join('<br>')}</td></tr>`).join('')}</tbody></table>
    </section>`);
  }

  if (want('changes') && diff) {
    const d = diff, ds = d.summary;
    parts.push(`
    <section class="break">
      <h2>Changes ${esc(d.from.version || '')} → ${esc(d.to.version || '')}</h2>
      <div class="cards">
        ${card(`+${ds.filesAdded} / −${ds.filesRemoved} / ~${ds.filesChanged}`, 'files added / removed / changed')}
        ${card(`+${ds.endpointsAdded} / −${ds.endpointsRemoved}`, 'entry points added / removed', ds.endpointsAdded ? 'warn' : '')}
        ${card(ds.accessRegressions, 'access regressions', ds.accessRegressions ? 'bad' : 'good')}
        ${card(ds.possibleFixes, 'possible security fixes', ds.possibleFixes ? 'warn' : '')}
      </div>
      ${list('New entry points', d.endpoints.added.map((e) => `<code>${esc(e.name)}</code> (${esc(e.type)}, ${esc(e.auth)}) in ${esc(e.file)}`))}
      ${list('Access regressions', d.access.regressions.map((r) => `${sev(r.severity)} <code>${esc(r.name)}</code>: ${esc(r.change)}`))}
      ${list('Possible silent security fixes', d.possibleFixes.map((f) => `<code>${esc(f.file)}${f.line ? ':' + f.line : ''}</code>: ${esc(f.message)}`))}
      ${list('New findings', d.issues.added.map((i) => `${sev(i.severity)} <code>${esc(i.file)}:${i.line}</code>: ${esc(i.message)}`))}
    </section>`);
  }

  if (want('runtime') && trace) {
    parts.push(`
    <section class="break">
      <h2>Runtime coverage</h2>
      <p>${trace.matchedRequests} recorded request(s) loaded ${Object.keys(trace.observed).length} of the package's PHP files (${Math.round(trace.coverage * 100)}%).</p>
      ${list('Requests observed', trace.requests.slice(0, 30).map((r) => `<code>${esc(r.kind)} ${esc(r.target)}</code> ×${r.count}, ${r.files.length} file(s)`))}
      ${list('PHP files never loaded during the trace', trace.neverLoaded.slice(0, 60).map((f) => `<code>${esc(f)}</code>`))}
    </section>`);
  }

  parts.push(`
  <section class="break method">
    <h2>Methodology &amp; limitations</h2>
    <p>This report was produced by Pluginlore, a static analyser. It reads source code and never executes it or sends requests to any site.</p>
    <ul>
      <li><strong>Findings are leads, not proof.</strong> Pattern-based checks produce false positives, and a clean result does not mean the code is secure.</li>
      <li>Access-control checks detect the <em>presence</em> of capability/nonce calls, not that they are correctly enforced.</li>
      <li>Dynamic includes, variable function names and data that flows through the database cannot be fully followed.</li>
      ${m.vulnScan ? '' : '<li>The vulnerability scan was not enabled for this report, so vulnerability and access verdicts are omitted.</li>'}
    </ul>
  </section>
  <footer>Generated with Pluginlore · ${esc(new Date().toISOString())}</footer>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Code review</title><style>${CSS}</style></head><body><main>${parts.join('\n')}</main></body></html>`;
}

function summaryBullets(model, diff, trace) {
  const out = [];
  const s = model.stats, m = model.meta;
  const pub = (model.access || []).filter((a) => a.auth === 'unauth' || a.type === 'rest').length;
  out.push(`${(model.access || []).length} request handler(s) found, ${pub} of them callable without logging in.`);
  if (m.vulnScan) {
    const high = (model.access || []).filter((a) => a.severity === 'high');
    if (high.length) out.push(`<strong>${high.length} handler(s) change data without adequate checks</strong>: ${high.slice(0, 4).map((a) => `<code>${esc(a.name)}</code>`).join(', ')}${high.length > 4 ? '…' : ''}.`);
    if (s.vuln) out.push(`${s.vuln} code pattern(s) commonly linked to vulnerabilities (injection, XSS, unsafe deserialisation).`);
  }
  if (s.directAccess) out.push(`${s.directAccess} file(s) can be requested directly and read request input without an <code>ABSPATH</code> guard.`);
  if (s.perf) out.push(`${s.perf} performance hint(s), mostly queries running inside loops.`);
  if (s.conflictsHigh) out.push(`<strong>${s.conflictsHigh} duplicate declaration(s)</strong> that would stop PHP with a fatal error if both copies load.`);
  if (diff) out.push(`Compared with ${esc(diff.from.version || 'the previous version')}: ${diff.summary.endpointsAdded} new entry point(s), ${diff.summary.accessRegressions} access regression(s), ${diff.summary.possibleFixes} possible security fix(es).`);
  if (trace) out.push(`Runtime trace: ${trace.matchedRequests} request(s) recorded, ${Math.round(trace.coverage * 100)}% of PHP files loaded at least once.`);
  return out;
}

const row = (k, v) => `<div class="k">${esc(k)}</div><div>${esc(v)}</div>`;
const card = (n, label, tone = '') => `<div class="card ${tone}"><div class="n">${esc(n)}</div><div class="l">${esc(label)}</div></div>`;
// Inline SVG (the standalone report has no icon sprite).
const tick = (v) => (v
  ? '<svg class="tick yes" viewBox="0 0 24 24" role="img" aria-label="yes"><path d="m5 12 5 5 9-10"/></svg>'
  : '<svg class="tick no" viewBox="0 0 24 24" role="img" aria-label="no"><path d="M6 6l12 12M18 6 6 18"/></svg>');
const sev = (s) => `<span class="sev sev-${esc(s)}">${esc(s)}</span>`;
const list = (title, items) => (items.length ? `<h3>${esc(title)}</h3><ul class="list">${items.slice(0, 80).map((i) => `<li>${i}</li>`).join('')}</ul>` : '');
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const CSS = `
:root{--t:#1f1e1c;--m:#6b6963;--b:#e3e1dd;--s:#f5f4f2;--bad:#c0392b;--warn:#c9821a;--good:#2f8f5b}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--t);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:40px 32px}
h1{font-size:30px;margin:18px 0 16px;letter-spacing:-.01em}h2{font-size:19px;margin:34px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--b)}h3{font-size:14px;margin:18px 0 6px}
.muted{color:var(--m)}.small{font-size:12px}code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--s);padding:1px 5px;border-radius:4px;word-break:break-all}
.cover{border-bottom:2px solid var(--t);padding-bottom:22px}.brandline{display:flex;gap:14px;align-items:center}.logo{max-height:56px;max-width:180px}.agency{font-weight:650;font-size:16px}
.meta-grid{display:grid;grid-template-columns:160px 1fr;gap:4px 16px;font-size:13px}.meta-grid .k{color:var(--m)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0}
.card{border:1px solid var(--b);border-radius:8px;padding:12px 14px}.card .n{font-size:22px;font-weight:650}.card .l{color:var(--m);font-size:12px}
.card.bad .n{color:var(--bad)}.card.warn .n{color:var(--warn)}.card.good .n{color:var(--good)}
.bullets li{margin:4px 0}.notes{background:var(--s);border-radius:8px;padding:4px 16px 10px;margin-top:14px}
.graph{width:100%;border:1px solid var(--b);border-radius:8px}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}th,td{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid var(--b)}th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--m)}
tr{break-inside:avoid}.tick{width:16px;height:16px;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;vertical-align:-3px}.tick.yes{stroke:var(--good)}.tick.no{stroke:var(--bad)}
.sev{display:inline-block;font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.03em;padding:1px 7px;border-radius:4px;background:var(--s)}
.sev-critical,.sev-high{background:#fbe3e0;color:var(--bad)}.sev-medium{background:#fbefd9;color:#9a5f0c}.sev-low{background:#eceae6;color:var(--m)}.sev-ok{background:#e2f2e8;color:var(--good)}
.list li{margin:3px 0}.method{font-size:13px}footer{margin-top:40px;color:var(--m);font-size:11px;border-top:1px solid var(--b);padding-top:10px}
@media print{main{padding:0}.break{break-before:auto}h2{break-after:avoid}@page{margin:16mm}}
`;
