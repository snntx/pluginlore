#!/usr/bin/env node
// Pluginlore CLI - static analysis of PHP packages. Never executes code, never
// sends requests.
//
//   pluginlore <zip|dir> [options]            analyse one package (or a whole site)
//   pluginlore diff <old> <new> [options]     compare two versions
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ingestZip, junkReason } from '../core/ingest.js';
import { analyze } from '../core/analyze.js';
import { simulate } from '../core/simulate.js';
import { toSarif } from '../core/sarif.js';
import { diffModels, orderModels } from '../core/diff.js';

const SEV = { info: 0, ok: 0, low: 1, medium: 2, high: 3, critical: 4 };
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(`Pluginlore - WordPress plugin & theme inspector (static analysis)

Usage:
  pluginlore <plugin-or-theme.zip | directory> [options]
  pluginlore diff <old.zip|dir> <new.zip|dir> [options]

Analyse options:
  --php <version>        Also flag PHP functions deprecated by this version (off by default)
  --vuln                 Include vulnerability + access-control findings (heuristic)
  --json <file>          Write the full model as JSON
  --sarif <file>         Write SARIF 2.1.0 (GitHub Code Scanning)
  --path-prefix <dir>    Prefix file paths in SARIF (where the package lives in your repo)
  --simulate <file>      Trace signal paths from a file inside the package
  --fail-on <severity>   Exit 1 if any finding is at or above: low|medium|high|critical

Diff options:
  --json <file>          Write the diff as JSON
  --fail-on-regression   Exit 1 if access checks were removed or new weak endpoints appeared

Environment:
  PLUGINLORE_VULN_SCAN=0 disables vulnerability/access findings entirely.

Results are heuristics, not proof. Only test software you are authorised to test.`);
  process.exit(0);
}

const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
const phpTarget = flag('--php') || null; // deprecation checks are opt-in
const vulnScan = args.includes('--vuln') && process.env.PLUGINLORE_VULN_SCAN !== '0';

if (args[0] === 'diff') runDiff(); else runAnalyze();

function runAnalyze() {
  const model = analyze(load(args[0]), { phpTarget, vulnScan });
  const s = model.stats;

  console.log(`\nPluginlore  ·  ${model.meta.packageType}${model.meta.packageName ? `  ·  ${model.meta.packageName} ${model.meta.packageVersion || ''}` : ''}`);
  console.log(`${model.meta.fileCount} PHP · ${model.meta.jsCount} JS · ${model.edges.length} relationships · ${model.meta.parseErrors} parse errors`);
  if (model.meta.packages.length > 1) {
    console.log(`\nPackages (${model.meta.packages.length}):`);
    for (const p of model.meta.packages) console.log(`  ${p.kind.padEnd(6)} ${p.dir.padEnd(28)} ${p.name} ${p.version || ''}`);
  }
  console.log('\nVisibility:');
  for (const [k, v] of Object.entries(s.byReach)) console.log(`  ${k.padEnd(14)} ${v}`);

  if (model.access.length) {
    console.log(`\nAccess-control audit (${model.access.length} handlers):`);
    for (const a of [...model.access].sort((x, y) => SEV[y.severity] - SEV[x.severity])) {
      const checks = `cap:${a.cap ? 'yes' : 'no '} nonce:${a.nonce ? 'yes' : 'no '}`;
      console.log(`  ${a.severity.padEnd(6)} ${a.name.padEnd(36)} ${checks}  ${a.message}`);
    }
  }

  console.log('\nSignals:');
  console.log(`  direct-access files   ${s.directAccess}`);
  if (phpTarget) console.log(`  deprecated usages     ${s.deprecated}  (PHP ${phpTarget})`);
  console.log(`  performance hints     ${s.perf}`);
  console.log(`  duplicate declarations ${s.conflicts} (${s.conflictsHigh} fatal-risk)`);
  if (vulnScan) console.log(`  potential vulns       ${s.vuln}   access findings ${s.byKind.access}   (heuristic: verify manually)`);
  else console.log('  vulnerability scan    off (pass --vuln to enable)');

  const findings = model.nodes.flatMap((n) => n.issues.map((i) => ({ file: n.path, ...i })));
  if (findings.length) {
    console.log('\nFindings:');
    for (const f of findings.sort((a, b) => SEV[b.severity] - SEV[a.severity]).slice(0, 50)) {
      console.log(`  [${f.severity}] ${f.kind.padEnd(10)} ${f.file}:${f.line}  ${f.message}`);
    }
    if (findings.length > 50) console.log(`  … ${findings.length - 50} more (use --json or --sarif for all)`);
  }

  const simFrom = flag('--simulate');
  if (simFrom) {
    const node = model.nodes.find((n) => n.path === simFrom || n.path.endsWith('/' + simFrom) || n.label === simFrom);
    if (!node) console.error(`\nSimulate: file "${simFrom}" not found.`);
    else {
      const r = simulate(model, node.id);
      console.log(`\nSignal from ${node.path}: ${r.visited.length} files reached, ${r.paths.length} paths, ${r.endpoints.length} dead ends, ${r.sinks.length} sinks on path.`);
      for (const p of r.paths.slice(0, 20)) console.log('  ' + p.join('  →  '));
    }
  }

  const jsonOut = flag('--json');
  if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(model, null, 2)); console.log(`\nWrote ${jsonOut}`); }
  const sarifOut = flag('--sarif');
  if (sarifOut) { writeFileSync(sarifOut, JSON.stringify(toSarif(model, { pathPrefix: flag('--path-prefix') }), null, 2)); console.log(`Wrote ${sarifOut}`); }

  const failOn = flag('--fail-on');
  if (failOn && SEV[failOn] != null) {
    const worst = findings.reduce((m, f) => Math.max(m, SEV[f.severity] || 0), 0);
    if (worst >= SEV[failOn]) { console.log(`\nFailing: found findings at or above "${failOn}".`); process.exit(1); }
  }
  console.log('');
}

function runDiff() {
  if (!args[1] || !args[2]) { console.error('Usage: pluginlore diff <old> <new>'); process.exit(2); }
  const a = analyze(load(args[1]), { phpTarget, vulnScan: process.env.PLUGINLORE_VULN_SCAN !== '0' });
  const b = analyze(load(args[2]), { phpTarget, vulnScan: process.env.PLUGINLORE_VULN_SCAN !== '0' });
  const { oldModel, newModel, swapped } = orderModels(a, b);
  const d = diffModels(oldModel, newModel);
  const s = d.summary;

  console.log(`\nPluginlore diff  ·  ${d.from.name || 'old'} ${d.from.version || ''}  →  ${d.to.version || 'new'}${swapped ? '   (ordered by Version header)' : ''}`);
  console.log(`Files: +${s.filesAdded} −${s.filesRemoved} ~${s.filesChanged}   Endpoints: +${s.endpointsAdded} −${s.endpointsRemoved} (auth changed: ${s.endpointsAuthChanged})`);
  console.log(`Findings: +${s.issuesAdded} −${s.issuesRemoved}   Access: ${s.accessRegressions} regressions, ${s.accessImprovements} improvements`);

  const section = (title, rows, fmt) => { if (rows.length) { console.log(`\n${title}:`); for (const r of rows.slice(0, 40)) console.log('  ' + fmt(r)); } };
  section('New entry points', d.endpoints.added, (e) => `${e.type.padEnd(10)} ${e.name}  (${e.auth})  ${e.file}`);
  section('Removed entry points', d.endpoints.removed, (e) => `${e.type.padEnd(10)} ${e.name}  ${e.file}`);
  section('Access regressions', d.access.regressions, (r) => `[${r.severity}] ${r.name}: ${r.change}`);
  section('Possible silent security fixes', d.possibleFixes, (f) => `${f.kind.padEnd(8)} ${f.file}${f.line ? ':' + f.line : ''}  ${f.message}`);
  section('New findings', d.issues.added, (i) => `[${i.severity}] ${i.kind.padEnd(10)} ${i.file}:${i.line}  ${i.message}`);

  const jsonOut = flag('--json');
  if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(d, null, 2)); console.log(`\nWrote ${jsonOut}`); }
  if (args.includes('--fail-on-regression') && s.accessRegressions > 0) { console.log('\nFailing: access-control regressions found.'); process.exit(1); }
  console.log('');
}

function load(input) {
  if (!input) { console.error('No input given.'); process.exit(2); }
  if (input.toLowerCase().endsWith('.zip')) return ingestZip(new Uint8Array(readFileSync(input))).files;
  return readDir(resolve(input));
}

function readDir(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name.endsWith('.zip') || junkReason(relative(base, p))) continue;
    const st = statSync(p);
    if (st.isDirectory()) readDir(p, base, acc);
    else if (st.size < 5 * 1024 * 1024) {
      try { acc.push({ path: relative(base, p), content: readFileSync(p, 'utf8') }); } catch {}
    }
  }
  return acc;
}
