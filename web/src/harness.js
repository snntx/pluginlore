// PHP scripts that run inside the in-browser WordPress (WordPress Playground).
// Pure string builders, no DOM, so tests can syntax-check them with `php -l`.
//
// The call harness:
//   - loads WordPress with the plugin active
//   - acts as a visitor / subscriber / administrator
//   - optionally pretends nonce checks pass (pluggable wp_verify_nonce)
//   - calls the function with the given arguments
//   - records every hook that ran plugin code, in order, with the output each
//     step added (the "step by step" trace across files)
//   - turns wp_die() / wp_send_json() into a catchable stop, survives exit()
//   - prints one JSON result after a marker, even after exit or a fatal error

export const WP_ROOT = '/wordpress';
export const CONTENT = '/wordpress/wp-content/';
export const RESULT_MARKER = '@@PLUGINLORE_RESULT@@';

const b64 = (obj) => {
  const json = JSON.stringify(obj);
  // UTF-8 safe base64 in both browsers and Node
  if (typeof Buffer !== 'undefined') return Buffer.from(json, 'utf8').toString('base64');
  return btoa(unescape(encodeURIComponent(json)));
};

// Activate the installed package (plugins) or switch to it (themes).
export function activateScript({ kind, plugins = [], theme = null }) {
  return `<?php
require_once '${WP_ROOT}/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
$in = json_decode(base64_decode('${b64({ kind, plugins, theme })}'), true);
$out = array('activated' => array(), 'errors' => array());
foreach ($in['plugins'] as $p) {
  $r = activate_plugin($p);
  if (is_wp_error($r)) { $out['errors'][] = $p . ': ' . $r->get_error_message(); }
  else { $out['activated'][] = $p; }
}
if (!empty($in['theme'])) { switch_theme($in['theme']); $out['activated'][] = 'theme:' . $in['theme']; }
if (!get_user_by('login', 'sl_subscriber')) {
  wp_insert_user(array('user_login' => 'sl_subscriber', 'user_pass' => wp_generate_password(24), 'role' => 'subscriber', 'user_email' => 'subscriber@example.com'));
}
echo '${RESULT_MARKER}' . json_encode($out);
`;
}

// Call one function or method with arguments and report everything it did.
export function callScript({ fn, cls = null, args = [], as = 'visitor', skipNonce = false, ajax = false, request = {} }) {
  const input = b64({ fn, cls, args, as, skipNonce, ajax, request });
  return `<?php
$__sl_in = json_decode(base64_decode('${input}'), true);
$GLOBALS['__sl'] = array('steps' => array(), 'errors' => array(), 'files' => array(), 'returned' => null, 'returnedType' => null,
  'stopped' => null, 'exception' => null, 'redirect' => null, 'notes' => array(), 'ms' => 0, 'done' => false);
$GLOBALS['__sl_root'] = '${CONTENT}';

if (!empty($__sl_in['skipNonce'])) {
  // WordPress only defines wp_verify_nonce() if nobody did first (it is "pluggable").
  function wp_verify_nonce($nonce, $action = -1) { return 1; }
}
define('PLUGINLORE_RUN', true);
require_once '${WP_ROOT}/wp-load.php';

class Pluginlore_Stop extends Exception {}

function pluginlore_cb_file($cb) {
  try {
    if (is_string($cb) && strpos($cb, '::') !== false) $cb = explode('::', $cb, 2);
    if (is_array($cb)) { $r = new ReflectionMethod(is_object($cb[0]) ? get_class($cb[0]) : $cb[0], $cb[1]); return $r->getFileName(); }
    if (is_string($cb) && function_exists($cb)) { $r = new ReflectionFunction($cb); return $r->getFileName(); }
    if ($cb instanceof Closure) { $r = new ReflectionFunction($cb); return $r->getFileName(); }
  } catch (Throwable $e) {}
  return null;
}
function pluginlore_cb_name($cb) {
  if (is_string($cb)) return $cb;
  if (is_array($cb)) return (is_object($cb[0]) ? get_class($cb[0]) : $cb[0]) . '::' . $cb[1];
  if ($cb instanceof Closure) { try { $r = new ReflectionFunction($cb); return 'closure (line ' . $r->getStartLine() . ')'; } catch (Throwable $e) {} }
  return 'callback';
}
function pluginlore_rel($file) {
  $root = $GLOBALS['__sl_root'];
  return ($file && strpos($file, $root) === 0) ? substr($file, strlen($root)) : null;
}
function pluginlore_export($v, $depth = 0) {
  if ($depth > 4) return '…';
  if (is_wp_error($v)) return array('__type' => 'WP_Error', 'code' => $v->get_error_code(), 'message' => $v->get_error_message());
  if ($v instanceof WP_REST_Response) return array('__type' => 'WP_REST_Response', 'status' => $v->get_status(), 'data' => pluginlore_export($v->get_data(), $depth + 1));
  if ($v instanceof WP_Post) return array('__type' => 'WP_Post', 'ID' => $v->ID, 'post_title' => $v->post_title, 'post_type' => $v->post_type, 'post_status' => $v->post_status);
  if ($v instanceof WP_User) return array('__type' => 'WP_User', 'ID' => $v->ID, 'user_login' => $v->user_login, 'roles' => $v->roles);
  if (is_object($v)) { $o = array('__type' => get_class($v)); foreach (array_slice(get_object_vars($v), 0, 30, true) as $k => $x) $o[$k] = pluginlore_export($x, $depth + 1); return $o; }
  if (is_array($v)) { $o = array(); foreach (array_slice($v, 0, 100, true) as $k => $x) $o[$k] = pluginlore_export($x, $depth + 1); return $o; }
  if (is_string($v) && strlen($v) > 20000) return substr($v, 0, 20000) . '… (cut)';
  if (is_float($v) && (is_nan($v) || is_infinite($v))) return (string) $v;
  return $v;
}
function pluginlore_arg($a) {
  $kind = isset($a['kind']) ? $a['kind'] : 'any';
  $v = array_key_exists('value', $a) ? $a['value'] : null;
  if ($kind === 'REST request') {
    $r = new WP_REST_Request('POST', '/pluginlore');
    if (is_array($v)) foreach ($v as $k => $x) $r->set_param($k, $x);
    return $r;
  }
  if ($kind === 'post object') { $p = is_numeric($v) ? get_post((int) $v) : null; return $p ? $p : get_post(1); }
  if ($kind === 'user object') { $u = is_numeric($v) ? get_userdata((int) $v) : null; return $u ? $u : wp_get_current_user(); }
  return $v;
}

// Who is calling
$__sl_as = $__sl_in['as'];
if ($__sl_as === 'admin') { wp_set_current_user(1); }
elseif ($__sl_as === 'subscriber') { $u = get_user_by('login', 'sl_subscriber'); wp_set_current_user($u ? $u->ID : 0); }
else { wp_set_current_user(0); }

// Warnings and notices become part of the report instead of the output
set_error_handler(function ($no, $str, $file, $line) {
  $names = array(E_WARNING => 'Warning', E_NOTICE => 'Notice', E_DEPRECATED => 'Deprecated', E_USER_WARNING => 'Warning', E_USER_NOTICE => 'Notice', E_USER_DEPRECATED => 'Deprecated', E_USER_ERROR => 'Error');
  if (count($GLOBALS['__sl']['errors']) < 50) $GLOBALS['__sl']['errors'][] = array('level' => isset($names[$no]) ? $names[$no] : 'Error', 'message' => $str, 'file' => pluginlore_rel($file) ?: basename($file), 'line' => $line);
  return true;
});

// wp_die() (and wp_send_json() in AJAX mode) stops the call in a way we can catch
$__sl_die = function () { return function ($message = '', $title = '', $args = array()) {
  if (is_wp_error($message)) $message = $message->get_error_message();
  throw new Pluginlore_Stop(is_scalar($message) ? (string) $message : wp_json_encode($message));
}; };
add_filter('wp_die_handler', $__sl_die, PHP_INT_MAX);
add_filter('wp_die_ajax_handler', $__sl_die, PHP_INT_MAX);
add_filter('wp_die_json_handler', $__sl_die, PHP_INT_MAX);
if (!empty($__sl_in['ajax'])) add_filter('wp_doing_ajax', '__return_true');
add_filter('wp_redirect', function ($loc) { $GLOBALS['__sl']['redirect'] = $loc; return $loc; }, PHP_INT_MAX);

// Step tracer: every hook that runs plugin code, with the output length at that moment
$__sl_level = ob_get_level();
$GLOBALS['__sl_level'] = $__sl_level;
// WordPress flushes every output buffer on shutdown, before our reporter runs; keep the output ours
remove_action('shutdown', 'wp_ob_end_flush_all', 1);
add_action('all', function () {
  global $wp_filter;
  $hook = current_filter();
  if (!empty($GLOBALS['__sl']['finished']) || !isset($wp_filter[$hook]) || count($GLOBALS['__sl']['steps']) >= 300) return;
  $cbs = array();
  foreach ($wp_filter[$hook]->callbacks as $prio => $list) {
    foreach ($list as $cb) {
      $rel = pluginlore_rel(pluginlore_cb_file($cb['function']));
      if ($rel !== null && preg_match('#^(plugins|themes)/#', $rel)) {
        $cbs[] = array('callback' => pluginlore_cb_name($cb['function']), 'file' => $rel, 'priority' => $prio);
      }
    }
  }
  if (!$cbs) return;
  $GLOBALS['__sl']['steps'][] = array('hook' => $hook, 'callbacks' => $cbs, 'at' => pluginlore_output_len());
});
// Output captured so far, summed across any buffers the plugin opened inside ours.
function pluginlore_output_len() {
  $len = 0;
  foreach (array_slice(ob_get_status(true), $GLOBALS['__sl_level']) as $b) $len += isset($b['buffer_used']) ? $b['buffer_used'] : 0;
  return $len;
}

// Always report, even after exit() or a fatal error
register_shutdown_function(function () {
  if ($GLOBALS['__sl']['done']) return;
  $GLOBALS['__sl']['done'] = true;
  $out = '';
  while (ob_get_level() > $GLOBALS['__sl_level']) { $out = ob_get_clean() . $out; }
  $fatal = error_get_last();
  if ($fatal && in_array($fatal['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
    $GLOBALS['__sl']['exception'] = array('type' => 'Fatal error', 'message' => $fatal['message'], 'file' => pluginlore_rel($fatal['file']) ?: basename($fatal['file']), 'line' => $fatal['line']);
  }
  if (!$GLOBALS['__sl']['stopped'] && !$GLOBALS['__sl']['exception'] && empty($GLOBALS['__sl']['finished'])) {
    $GLOBALS['__sl']['stopped'] = array('by' => 'exit', 'message' => 'The code called exit() or die(), which ends the whole request.');
  }
  if (empty($GLOBALS['__sl']['finished'])) $GLOBALS['__sl']['ms'] = round((microtime(true) - $GLOBALS['__sl_t0']) * 1000, 1);
  $after = get_included_files();
  foreach (array_diff($after, $GLOBALS['__sl_before']) as $f) { $r = pluginlore_rel($f); if ($r !== null) $GLOBALS['__sl']['files'][] = $r; }
  $GLOBALS['__sl']['output'] = strlen($out) > 200000 ? substr($out, 0, 200000) . "\\n… (cut)" : $out;
  echo '${RESULT_MARKER}' . json_encode($GLOBALS['__sl'], JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
});

// Request input the function reads ($_POST / $_GET / $_COOKIE), as if a browser sent it
$__sl_req = isset($__sl_in['request']) && is_array($__sl_in['request']) ? $__sl_in['request'] : array();
foreach (array('GET' => '_GET', 'POST' => '_POST', 'COOKIE' => '_COOKIE') as $__k => $__g) {
  if (!empty($__sl_req[$__k]) && is_array($__sl_req[$__k])) foreach ($__sl_req[$__k] as $__n => $__v) { $GLOBALS[$__g][$__n] = wp_slash($__v); }
}
$_REQUEST = array_merge($_GET, $_POST, isset($__sl_req['REQUEST']) && is_array($__sl_req['REQUEST']) ? wp_slash($__sl_req['REQUEST']) : array());
if (!empty($__sl_req['POST'])) $_SERVER['REQUEST_METHOD'] = 'POST';

$GLOBALS['__sl_before'] = get_included_files();
$args = array_map('pluginlore_arg', $__sl_in['args']);
ob_start();
$GLOBALS['__sl_t0'] = microtime(true);
try {
  $cls = $__sl_in['cls'];
  $fn = $__sl_in['fn'];
  if ($cls) {
    if (!class_exists($cls)) throw new Exception("The class $cls isn't loaded when WordPress starts, so it can't be called directly.");
    $m = new ReflectionMethod($cls, $fn);
    $m->setAccessible(true);
    if ($m->isStatic()) { $ret = $m->invokeArgs(null, $args); }
    else {
      try { $obj = new $cls(); }
      catch (Throwable $e) { $obj = (new ReflectionClass($cls))->newInstanceWithoutConstructor(); $GLOBALS['__sl']['notes'][] = "Created $cls without running its constructor (it needs arguments)."; }
      $ret = $m->invokeArgs($obj, $args);
    }
  } else {
    if (!function_exists($fn)) throw new Exception("$fn() isn't loaded when WordPress starts, so it can't be called directly.");
    $ret = call_user_func_array($fn, $args);
  }
  $GLOBALS['__sl']['returned'] = pluginlore_export($ret);
  $GLOBALS['__sl']['returnedType'] = is_object($ret) ? get_class($ret) : gettype($ret);
} catch (Pluginlore_Stop $e) {
  $GLOBALS['__sl']['stopped'] = array('by' => 'wp_die', 'message' => $e->getMessage());
} catch (Throwable $e) {
  $GLOBALS['__sl']['exception'] = array('type' => get_class($e), 'message' => $e->getMessage(), 'file' => pluginlore_rel($e->getFile()) ?: basename($e->getFile()), 'line' => $e->getLine());
}
$GLOBALS['__sl']['finished'] = true;
$GLOBALS['__sl']['ms'] = round((microtime(true) - $GLOBALS['__sl_t0']) * 1000, 1);
exit; // hands over to the shutdown reporter
`;
}

// Split the run response into { output, result } (result parsed from JSON).
export function parseResult(text) {
  const i = String(text).lastIndexOf(RESULT_MARKER);
  if (i === -1) return { result: null, stray: text };
  let result = null;
  try { result = JSON.parse(text.slice(i + RESULT_MARKER.length)); } catch { result = null; }
  return { result, stray: text.slice(0, i) };
}

// Turn the recorded steps into per-step output chunks.
export function stepChunks(result) {
  const steps = (result && result.steps) || [];
  const out = (result && result.output) || '';
  return steps.map((s, i) => {
    const end = i + 1 < steps.length ? steps[i + 1].at : out.length;
    return { ...s, output: out.slice(Math.min(s.at, out.length), Math.max(s.at, Math.min(end, out.length))) };
  });
}
