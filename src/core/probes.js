// Generate copy-paste probe commands for a node's entry points. These are TEXT
// only — Pluginlore never sends them. Run them yourself against a LOCAL test
// site you own. `base` defaults to a localhost dev site.

export function generateProbes(node, opts = {}) {
  const base = (opts.base || 'http://localhost:8888').replace(/\/+$/, '');
  const probes = [];

  for (const ep of node.entryPoints || []) {
    if (ep.type === 'ajax') {
      const action = ep.name.replace(/^wp_ajax_(nopriv_)?/, '');
      probes.push({
        title: `AJAX: ${ep.name}${ep.auth === 'unauth' ? ' (unauthenticated)' : ' (requires login)'}`,
        auth: ep.auth,
        cmd: `curl -s -X POST '${base}/wp-admin/admin-ajax.php' \\\n  --data-urlencode 'action=${action}'`,
        custom: `# add/override params to test unexpected input:\ncurl -s -X POST '${base}/wp-admin/admin-ajax.php' \\\n  --data-urlencode 'action=${action}' \\\n  --data-urlencode 'id=1 OR 1=1' \\\n  --data-urlencode 'x=<script>alert(1)</script>'`,
      });
    } else if (ep.type === 'admin-post') {
      const action = ep.name.replace(/^admin_post_(nopriv_)?/, '');
      probes.push({
        title: `admin-post: ${ep.name}`,
        auth: ep.auth,
        cmd: `curl -s -X POST '${base}/wp-admin/admin-post.php' \\\n  --data-urlencode 'action=${action}'`,
      });
    } else if (ep.type === 'rest') {
      probes.push({
        title: `REST route: ${ep.name}`,
        auth: ep.auth,
        cmd: `curl -s '${base}/wp-json/${String(ep.name).replace(/^\/+/, '')}'`,
        custom: `# POST with a body:\ncurl -s -X POST '${base}/wp-json/${String(ep.name).replace(/^\/+/, '')}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"id": 1}'`,
      });
    } else if (ep.type === 'shortcode') {
      probes.push({
        title: `Shortcode: [${ep.name}]`,
        auth: 'content',
        cmd: `# Place [${ep.name}] in a post/page on your local site and load it.`,
      });
    }
  }

  // JS files: probe the endpoints the script calls.
  for (const j of node.jsCalls || []) {
    if (j.endpoint === 'ajax' && j.action) {
      probes.push({
        title: `JS → AJAX action: ${j.action}`,
        auth: 'unauth',
        cmd: `curl -s -X ${j.method === 'GET' ? 'GET' : 'POST'} '${base}/wp-admin/admin-ajax.php' \\\n  --data-urlencode 'action=${j.action}'`,
        custom: `# unexpected input:\ncurl -s -X POST '${base}/wp-admin/admin-ajax.php' \\\n  --data-urlencode 'action=${j.action}' \\\n  --data-urlencode 'id=1 OR 1=1'`,
      });
    } else if (j.endpoint === 'rest' && j.path) {
      probes.push({
        title: `JS → REST: ${j.path}`,
        auth: 'unauth',
        cmd: `curl -s -X ${j.method} '${base}/wp-json/${String(j.path).replace(/^\/+/, '')}'${j.method !== 'GET' ? " \\\n  -H 'Content-Type: application/json' -d '{}'" : ''}`,
      });
    }
  }

  if (node.directAccess) {
    probes.push({
      title: `Direct file access: ${node.path}`,
      auth: 'unauth',
      cmd: `curl -s '${base}/wp-content/.../${node.label}?id=1'`,
      custom: `# test unexpected input on a directly-reachable file:\ncurl -s '${base}/wp-content/.../${node.label}?id=1%27%20OR%20%271%27=%271'`,
    });
  }

  if (probes.length === 0) {
    probes.push({
      title: 'No external entry point detected',
      auth: 'internal',
      cmd: `# ${node.path} appears to be reached only through other files (internal).\n# Trace it by simulating from an entry-point node instead.`,
    });
  }

  return probes;
}
