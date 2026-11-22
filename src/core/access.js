// Access-control audit: for every AJAX / admin-post / REST handler, work out
// whether the handler (or a helper it calls) checks capability, login state and
// a nonce, and whether it changes data. Missing authorization is the most
// common real-world WordPress plugin vulnerability class (CWE-862 / CWE-352).
//
// Everything here is based on the PRESENCE of calls, not proof they are
// enforced (e.g. `current_user_can('x');` without an `if` still counts).

import { walk, callName } from './walk.js';

const CAP = new Set(['current_user_can', 'user_can', 'is_super_admin', 'current_user_can_for_blog', 'author_can', 'is_admin_user']);
const LOGIN = new Set(['is_user_logged_in']);
const NONCE = new Set(['check_ajax_referer', 'wp_verify_nonce', 'check_admin_referer']);

// Functions that change state (data, files, users, settings, mail).
const WRITES = new Set([
  'update_option', 'add_option', 'delete_option', 'update_site_option', 'delete_site_option',
  'update_post_meta', 'add_post_meta', 'delete_post_meta', 'update_user_meta', 'add_user_meta', 'delete_user_meta',
  'update_term_meta', 'delete_term_meta', 'update_comment_meta',
  'wp_insert_post', 'wp_update_post', 'wp_delete_post', 'wp_trash_post',
  'wp_insert_user', 'wp_update_user', 'wp_delete_user', 'wp_create_user', 'wp_set_password',
  'wp_insert_term', 'wp_update_term', 'wp_delete_term', 'wp_set_object_terms',
  'wp_insert_comment', 'wp_update_comment', 'wp_delete_comment',
  'file_put_contents', 'fwrite', 'unlink', 'rename', 'copy', 'mkdir', 'rmdir',
  'move_uploaded_file', 'wp_handle_upload', 'media_handle_upload', 'wp_insert_attachment',
  'switch_theme', 'activate_plugin', 'deactivate_plugins', 'delete_plugins',
  'set_transient', 'delete_transient', 'wp_schedule_event', 'wp_mail',
]);
const WPDB_WRITE_METHODS = new Set(['query', 'insert', 'update', 'delete', 'replace']);
const ROLE_METHODS = new Set(['set_role', 'add_role', 'remove_role', 'add_cap', 'remove_cap']);

// Walk a function body (and up to 2 levels of helpers it calls) collecting checks.
export function bodyFacts(fnNode, resolveFn, depth = 0, seen = new Set()) {
  const f = { cap: false, login: false, nonce: false, writes: new Set(), helpers: [] };
  if (!fnNode || seen.has(fnNode)) return f;
  seen.add(fnNode);
  walk(fnNode.body || fnNode, (n) => {
    if (n.kind !== 'call') return;
    const name = callName(n);
    if (!name) return;
    if (CAP.has(name)) f.cap = true;
    if (LOGIN.has(name)) f.login = true;
    if (NONCE.has(name)) f.nonce = true;
    if (WRITES.has(name)) f.writes.add(name + '()');
    if (name.startsWith('->')) {
      const m = name.slice(2);
      const target = n.what && n.what.what;
      const onWpdb = target && target.kind === 'variable' && target.name === 'wpdb';
      if (onWpdb && WPDB_WRITE_METHODS.has(m)) f.writes.add('$wpdb->' + m + '()');
      if (ROLE_METHODS.has(m)) f.writes.add('->' + m + '()');
    }
    // follow helpers one/two levels deep (e.g. a shared verify_request())
    if (depth < 2 && resolveFn) {
      const helper = resolveFn(name);
      if (helper && !seen.has(helper)) {
        const sub = bodyFacts(helper, resolveFn, depth + 1, seen);
        if (sub.cap || sub.login || sub.nonce || sub.writes.size) f.helpers.push(name.replace(/^->/, ''));
        f.cap ||= sub.cap; f.login ||= sub.login; f.nonce ||= sub.nonce;
        for (const w of sub.writes) f.writes.add(w);
      }
    }
  });
  return f;
}

// Decide the verdict for one handler.
export function verdict(entry) {
  const writes = entry.writes.length > 0;
  const W = writes ? entry.writes.slice(0, 3).join(', ') + (entry.writes.length > 3 ? '…' : '') : '';
  if (!entry.resolved) {
    return { severity: 'info', cwe: null, message: 'Handler could not be resolved statically. Review it manually.' };
  }
  if (entry.type === 'rest') {
    if (entry.permission === 'none') {
      return writes
        ? { severity: 'high', cwe: 'CWE-862', message: `REST route has no permission_callback (public) and changes data: ${W}` }
        : { severity: 'low', cwe: 'CWE-862', message: 'REST route has no permission_callback. WordPress treats it as public.' };
    }
    if (entry.permission === 'open') {
      return writes
        ? { severity: 'high', cwe: 'CWE-862', message: `REST route is public (permission_callback returns true) and changes data: ${W}` }
        : { severity: 'ok', cwe: null, message: 'Public read-only REST route.' };
    }
    return { severity: 'ok', cwe: null, message: 'Route has a permission_callback.' };
  }
  // ajax / admin-post
  if (entry.auth === 'unauth') {
    // Registered for logged-out users, but a capability/login check inside the
    // handler still rejects anonymous callers.
    if (entry.cap || entry.login) {
      return writes && !entry.nonce
        ? { severity: 'medium', cwe: 'CWE-352', message: `Anonymous calls are rejected by the capability/login check, but there is no nonce check (CSRF): ${W}` }
        : { severity: 'ok', cwe: null, message: 'Open to logged-out users, but the handler checks capability/login before acting.' };
    }
    if (writes && !entry.nonce) return { severity: 'high', cwe: 'CWE-862', message: `Unauthenticated endpoint changes data with no nonce check: ${W}` };
    if (writes) return { severity: 'medium', cwe: 'CWE-862', message: `Unauthenticated endpoint changes data. Visitors can obtain the nonce, so it is not an access control: ${W}` };
    return { severity: 'ok', cwe: null, message: 'Public endpoint; no writes detected.' };
  }
  if (writes && !entry.cap) return { severity: 'high', cwe: 'CWE-862', message: `Missing capability check: any logged-in user (even a Subscriber) can trigger ${W}` };
  if (writes && !entry.nonce) return { severity: 'medium', cwe: 'CWE-352', message: `No nonce check: the action can be forged (CSRF): ${W}` };
  if (!entry.cap && !entry.login) return { severity: 'low', cwe: 'CWE-862', message: 'No capability check. No writes detected; check what data it returns.' };
  return { severity: 'ok', cwe: null, message: 'Capability and nonce checks present.' };
}
