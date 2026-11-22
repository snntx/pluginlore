// Version diff: compare two analysis models of the same package (old vs new)
// and report what changed from a security/maintenance point of view.
//
// The interesting outputs are:
//   - new / removed entry points (attack surface growing or shrinking)
//   - access regressions (a capability or nonce check disappeared)
//   - possible silent fixes (a finding or missing check vanished in a changed
//     file - this is how patched vulnerabilities are usually spotted)

const SEV_RANK = { ok: 0, info: 0, low: 1, medium: 2, high: 3, critical: 4 };

// Decide which model is older using the package Version header; fall back to
// the order given.
export function orderModels(a, b) {
  const va = a.meta.packageVersion, vb = b.meta.packageVersion;
  if (va && vb && compareVersions(va, vb) > 0) return { oldModel: b, newModel: a, swapped: true };
  return { oldModel: a, newModel: b, swapped: false };
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function diffModels(oldModel, newModel) {
  const oldNodes = new Map(oldModel.nodes.map((n) => [n.id, n]));
  const newNodes = new Map(newModel.nodes.map((n) => [n.id, n]));

  // ---- files ----
  const files = { added: [], removed: [], changed: [] };
  const nodeStatus = {};
  for (const [id, n] of newNodes) {
    const o = oldNodes.get(id);
    if (!o) { files.added.push(id); nodeStatus[id] = 'added'; }
    else if (o.hash !== n.hash) { files.changed.push({ id, locDelta: n.loc - o.loc }); nodeStatus[id] = 'changed'; }
  }
  for (const id of oldNodes.keys()) if (!newNodes.has(id)) files.removed.push(id);

  // ---- entry points (attack surface) ----
  const epKey = (ep) => `${ep.type}|${ep.name}`;
  const collectEps = (model) => {
    const m = new Map();
    for (const n of model.nodes) for (const ep of n.entryPoints) m.set(epKey(ep), { ...ep, file: n.id });
    return m;
  };
  const oldEps = collectEps(oldModel), newEps = collectEps(newModel);
  const endpoints = { added: [], removed: [], authChanged: [] };
  for (const [k, ep] of newEps) {
    const o = oldEps.get(k);
    if (!o) endpoints.added.push(ep);
    else if (o.auth !== ep.auth || (o.permission || null) !== (ep.permission || null)) endpoints.authChanged.push({ before: o, after: ep });
  }
  for (const [k, ep] of oldEps) if (!newEps.has(k)) endpoints.removed.push(ep);

  // ---- access checks ----
  const accKey = (a) => `${a.type}|${a.name}`;
  const oldAcc = new Map((oldModel.access || []).map((a) => [accKey(a), a]));
  const access = { regressions: [], improvements: [] };
  for (const a of newModel.access || []) {
    const o = oldAcc.get(accKey(a));
    if (!o) {
      if (SEV_RANK[a.severity] >= SEV_RANK.medium) access.regressions.push({ name: a.name, file: a.file, change: 'New endpoint with weak access control', severity: a.severity, detail: a.message });
      continue;
    }
    const lost = [], gained = [];
    for (const [key, label] of [['cap', 'capability check'], ['nonce', 'nonce check'], ['login', 'login check']]) {
      if (o[key] && !a[key]) lost.push(label);
      if (!o[key] && a[key]) gained.push(label);
    }
    if (o.permission && a.permission && o.permission !== a.permission) {
      if (a.permission === 'open' || a.permission === 'none') lost.push(`permission_callback (${o.permission} → ${a.permission})`);
      else gained.push(`permission_callback (${o.permission} → ${a.permission})`);
    }
    const newWrites = a.writes.filter((w) => !o.writes.includes(w));
    if (lost.length || (SEV_RANK[a.severity] > SEV_RANK[o.severity])) {
      access.regressions.push({
        name: a.name, file: a.file, severity: a.severity,
        change: lost.length ? `Removed ${lost.join(', ')}` : `Got weaker (${o.severity} → ${a.severity})`,
        detail: a.message,
      });
    }
    if (gained.length || SEV_RANK[a.severity] < SEV_RANK[o.severity]) {
      access.improvements.push({
        name: a.name, file: a.file, before: o.severity, after: a.severity,
        change: gained.length ? `Added ${gained.join(', ')}` : `Got stronger (${o.severity} → ${a.severity})`,
        possibleFix: SEV_RANK[o.severity] >= SEV_RANK.medium,
      });
    }
    if (newWrites.length && !a.cap && a.auth === 'auth') {
      access.regressions.push({ name: a.name, file: a.file, severity: 'high', change: `Now also writes ${newWrites.join(', ')} with no capability check`, detail: a.message });
    }
  }

  // ---- findings (ignore line numbers, which shift between versions) ----
  const issueKey = (fileId, i) => `${fileId}|${i.kind}|${i.symbol || ''}|${i.cwe || ''}|${(i.message || '').replace(/\d+/g, '#')}`;
  const count = (model) => {
    const m = new Map();
    for (const n of model.nodes) for (const i of n.issues) {
      const k = issueKey(n.id, i);
      if (!m.has(k)) m.set(k, { file: n.id, issue: i, n: 0 });
      m.get(k).n++;
    }
    return m;
  };
  const oldI = count(oldModel), newI = count(newModel);
  const issues = { added: [], removed: [] };
  for (const [k, v] of newI) {
    const before = oldI.get(k) ? oldI.get(k).n : 0;
    for (let i = before; i < v.n; i++) issues.added.push({ file: v.file, ...v.issue });
  }
  for (const [k, v] of oldI) {
    const after = newI.get(k) ? newI.get(k).n : 0;
    for (let i = after; i < v.n; i++) {
      const stillThere = newNodes.has(v.file);
      issues.removed.push({
        file: v.file, ...v.issue,
        // A security finding that vanished from a file that still exists (and changed)
        // is the classic signature of a quietly patched vulnerability.
        possibleFix: stillThere && ['vuln', 'access'].includes(v.issue.kind) && nodeStatus[v.file] === 'changed',
      });
    }
  }

  // One entry per underlying fix: an access improvement is only listed if the
  // matching access finding wasn't already reported as removed.
  const fromIssues = issues.removed.filter((i) => i.possibleFix).map((i) => ({ file: i.file, line: i.line, kind: i.kind, message: i.message }));
  const covered = new Set(fromIssues.filter((f) => f.kind === 'access').map((f) => f.message.split(':')[0]));
  const possibleFixes = [
    ...fromIssues,
    ...access.improvements.filter((a) => a.possibleFix && !covered.has(a.name)).map((a) => ({ file: a.file, kind: 'access', message: `${a.name}: ${a.change}` })),
  ];

  return {
    from: { name: oldModel.meta.packageName, version: oldModel.meta.packageVersion },
    to: { name: newModel.meta.packageName, version: newModel.meta.packageVersion },
    files, endpoints, access, issues, possibleFixes, nodeStatus,
    summary: {
      filesAdded: files.added.length, filesRemoved: files.removed.length, filesChanged: files.changed.length,
      endpointsAdded: endpoints.added.length, endpointsRemoved: endpoints.removed.length, endpointsAuthChanged: endpoints.authChanged.length,
      accessRegressions: access.regressions.length, accessImprovements: access.improvements.length,
      issuesAdded: issues.added.length, issuesRemoved: issues.removed.length, possibleFixes: possibleFixes.length,
    },
  };
}
