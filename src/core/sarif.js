// SARIF 2.1.0 export, the format GitHub Code Scanning (and most CI security
// dashboards) ingest. One rule per finding type; one result per finding.

const LEVEL = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' };
const SEC_SEVERITY = { critical: '9.5', high: '8.0', medium: '5.5', low: '3.0', info: '1.0' };
const KIND_TITLE = {
  vuln: 'Potential vulnerability pattern',
  access: 'Access-control weakness',
  deprecated: 'Deprecated PHP API',
  perf: 'Performance hint',
  conflict: 'Duplicate declaration',
};

function ruleId(issue) {
  if (issue.kind === 'vuln' || issue.kind === 'access') return `pluginlore/${issue.kind}/${issue.cwe || 'generic'}`;
  if (issue.kind === 'deprecated') return `pluginlore/deprecated/${issue.symbol || 'api'}`;
  if (issue.kind === 'perf') return `pluginlore/perf/${/loop/i.test(issue.message) ? 'loop-query' : 'unbounded-query'}`;
  if (issue.kind === 'conflict') return 'pluginlore/conflict/redeclare';
  return `pluginlore/${issue.kind}`;
}

export function toSarif(model, opts = {}) {
  const prefix = (opts.pathPrefix || '').replace(/\/+$/, '');
  const rules = new Map();
  const results = [];

  for (const n of model.nodes) {
    for (const issue of n.issues) {
      const id = ruleId(issue);
      const security = issue.kind === 'vuln' || issue.kind === 'access';
      if (!rules.has(id)) {
        rules.set(id, {
          id,
          name: id.split('/').slice(1).join('-'),
          shortDescription: { text: `${KIND_TITLE[issue.kind] || issue.kind}${issue.cwe ? ` (${issue.cwe})` : ''}` },
          helpUri: issue.cwe ? `https://cwe.mitre.org/data/definitions/${issue.cwe.replace('CWE-', '')}.html` : undefined,
          properties: {
            tags: [issue.kind, ...(security ? ['security'] : []), ...(issue.cwe ? [issue.cwe] : [])],
            ...(security ? { 'security-severity': SEC_SEVERITY[issue.severity] || '5.0' } : {}),
          },
        });
      }
      results.push({
        ruleId: id,
        level: LEVEL[issue.severity] || 'warning',
        message: { text: issue.message },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: prefix ? `${prefix}/${n.path}` : n.path },
            region: { startLine: Math.max(1, issue.line || 1) },
          },
        }],
        properties: { severity: issue.severity, ...(issue.confidence ? { confidence: issue.confidence } : {}) },
      });
    }
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Pluginlore', version: model.meta.version, rules: [...rules.values()] } },
      results,
      properties: {
        note: 'Static heuristics: findings are leads to review, not proof of a vulnerability.',
        packageType: model.meta.packageType,
        phpTarget: model.meta.phpTarget,
      },
    }],
  };
}
