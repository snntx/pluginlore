// Pattern-based security *heuristics*. These flag code shapes that are
// COMMONLY associated with vulnerabilities - they are NOT proof of a bug and
// WILL produce false positives and miss real issues. The UI gates this behind
// an explicit opt-in and a disclaimer. Keep this a plain data/rule file.

// Superglobals that carry attacker-controlled input ("sources").
export const TAINT_SOURCES = new Set([
  '$_GET', '$_POST', '$_REQUEST', '$_COOKIE', '$_FILES', '$_SERVER', '$HTTP_RAW_POST_DATA', 'php://input',
]);

// Dangerous "sinks": function name -> rule. `arg` is the (0-based) argument
// index that is dangerous when it carries tainted/unescaped input; `any` means
// any argument.
export const SINKS = {
  // --- SQL ---
  'mysqli_query': { cwe: 'CWE-89', kind: 'SQL injection', arg: 1, note: 'Use prepared statements.' },
  'mysql_query': { cwe: 'CWE-89', kind: 'SQL injection', arg: 0, note: 'Use prepared statements.' },
  'pg_query': { cwe: 'CWE-89', kind: 'SQL injection', arg: 'any', note: 'Use pg_query_params().' },
  // WordPress $wpdb->query/get_results/get_var etc. are handled as method calls below.

  // --- Command execution ---
  'exec': { cwe: 'CWE-78', kind: 'Command injection', arg: 0, note: 'Avoid shell; use escapeshellarg().' },
  'shell_exec': { cwe: 'CWE-78', kind: 'Command injection', arg: 0, note: 'Avoid shell execution.' },
  'system': { cwe: 'CWE-78', kind: 'Command injection', arg: 0, note: 'Avoid shell execution.' },
  'passthru': { cwe: 'CWE-78', kind: 'Command injection', arg: 0, note: 'Avoid shell execution.' },
  'popen': { cwe: 'CWE-78', kind: 'Command injection', arg: 0, note: 'Avoid shell execution.' },
  'proc_open': { cwe: 'CWE-78', kind: 'Command injection', arg: 0, note: 'Avoid shell execution.' },
  'pcntl_exec': { cwe: 'CWE-78', kind: 'Command injection', arg: 0, note: 'Avoid shell execution.' },

  // --- Code evaluation ---
  'eval': { cwe: 'CWE-95', kind: 'Code injection (eval)', arg: 0, note: 'Never eval dynamic input.' },
  'assert': { cwe: 'CWE-95', kind: 'Code injection (assert string)', arg: 0, note: 'Do not pass strings to assert().' },
  'create_function': { cwe: 'CWE-95', kind: 'Code injection', arg: 1, note: 'Use closures.' },
  'call_user_func': { cwe: 'CWE-94', kind: 'Dynamic call from input', arg: 0, note: 'Validate callback against an allow-list.' },
  'call_user_func_array': { cwe: 'CWE-94', kind: 'Dynamic call from input', arg: 0, note: 'Validate callback against an allow-list.' },

  // --- File / path ---
  'include': { cwe: 'CWE-98', kind: 'File inclusion', arg: 0, note: 'Never include() a dynamic path.' },
  'include_once': { cwe: 'CWE-98', kind: 'File inclusion', arg: 0, note: 'Never include a dynamic path.' },
  'require': { cwe: 'CWE-98', kind: 'File inclusion', arg: 0, note: 'Never require a dynamic path.' },
  'require_once': { cwe: 'CWE-98', kind: 'File inclusion', arg: 0, note: 'Never require a dynamic path.' },
  'fopen': { cwe: 'CWE-22', kind: 'Path traversal', arg: 0, note: 'Validate/normalize the path.' },
  'file_get_contents': { cwe: 'CWE-22', kind: 'Path traversal / SSRF', arg: 0, note: 'Validate the path/URL.' },
  'file_put_contents': { cwe: 'CWE-22', kind: 'Arbitrary file write', arg: 0, note: 'Validate the path.' },
  'readfile': { cwe: 'CWE-22', kind: 'Path traversal', arg: 0, note: 'Validate the path.' },
  'unlink': { cwe: 'CWE-22', kind: 'Arbitrary file delete', arg: 0, note: 'Validate the path.' },
  'fwrite': { cwe: 'CWE-22', kind: 'Arbitrary file write', arg: 'any', note: 'Validate the target.' },

  // --- Deserialization ---
  'unserialize': { cwe: 'CWE-502', kind: 'PHP object injection', arg: 0, note: "Use JSON, or ['allowed_classes'=>false]." },

  // --- SSRF ---
  'curl_setopt': { cwe: 'CWE-918', kind: 'Possible SSRF (CURLOPT_URL)', arg: 'any', note: 'Validate the URL host.' },

  // --- Output (XSS) ---
  'echo': { cwe: 'CWE-79', kind: 'Reflected XSS (unescaped output)', arg: 'any', note: 'Escape with htmlspecialchars()/esc_html().' },
  'print': { cwe: 'CWE-79', kind: 'Reflected XSS (unescaped output)', arg: 'any', note: 'Escape output.' },
  'printf': { cwe: 'CWE-79', kind: 'Reflected XSS (unescaped output)', arg: 'any', note: 'Escape output.' },
  'header': { cwe: 'CWE-113', kind: 'Header injection / open redirect', arg: 0, note: 'Validate header/redirect value.' },
};

// WordPress method-call sinks: $wpdb->METHOD(...). Flags string-built SQL.
export const WP_METHOD_SINKS = {
  'query': { cwe: 'CWE-89', kind: 'SQL injection ($wpdb->query)', note: 'Use $wpdb->prepare().' },
  'get_results': { cwe: 'CWE-89', kind: 'SQL injection ($wpdb->get_results)', note: 'Use $wpdb->prepare().' },
  'get_var': { cwe: 'CWE-89', kind: 'SQL injection ($wpdb->get_var)', note: 'Use $wpdb->prepare().' },
  'get_row': { cwe: 'CWE-89', kind: 'SQL injection ($wpdb->get_row)', note: 'Use $wpdb->prepare().' },
  'get_col': { cwe: 'CWE-89', kind: 'SQL injection ($wpdb->get_col)', note: 'Use $wpdb->prepare().' },
};

// Functions that neutralize taint ("sanitizers"). If a tainted value passes
// through one of these, we lower the confidence of a finding.
export const SANITIZERS = new Set([
  'esc_html', 'esc_attr', 'esc_url', 'esc_url_raw', 'esc_js', 'esc_textarea', 'esc_sql',
  'sanitize_text_field', 'sanitize_key', 'sanitize_email', 'sanitize_file_name',
  'absint', 'intval', 'floatval', 'wp_kses', 'wp_kses_post', 'htmlspecialchars',
  'htmlentities', 'strip_tags', 'filter_var', 'filter_input', 'addslashes',
  'escapeshellarg', 'escapeshellcmd', 'basename', 'realpath', 'wp_unslash_is_not_a_sanitizer',
]);

// Nonce / CSRF verification functions (presence weakens "missing CSRF" findings).
export const NONCE_FUNCS = new Set([
  'check_ajax_referer', 'wp_verify_nonce', 'check_admin_referer',
]);
