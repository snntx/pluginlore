// PHP *core* deprecated / removed functions and constants, keyed by symbol name.
// `deprecated` = version it was first deprecated; `removed` = version it was
// removed (if any). A symbol is flagged when the selected PHP target version
// is >= `deprecated`. This is a curated starter list, not exhaustive — it is
// deliberately a plain data file so it can be extended without touching logic.
//
// Sources: PHP migration guides (php.net/manual/en/migration*.php).

export const PHP_DEPRECATED = {
  // ---- removed in 7.0 (long deprecated before) ----
  ereg: { deprecated: '5.3', removed: '7.0', replacement: 'preg_match()' },
  eregi: { deprecated: '5.3', removed: '7.0', replacement: 'preg_match() with /i' },
  ereg_replace: { deprecated: '5.3', removed: '7.0', replacement: 'preg_replace()' },
  eregi_replace: { deprecated: '5.3', removed: '7.0', replacement: 'preg_replace() with /i' },
  split: { deprecated: '5.3', removed: '7.0', replacement: 'preg_split() or explode()' },
  spliti: { deprecated: '5.3', removed: '7.0', replacement: 'preg_split()' },
  sql_regcase: { deprecated: '5.3', removed: '7.0', replacement: null },
  call_user_method: { deprecated: '4.1', removed: '7.0', replacement: 'call_user_func()' },
  call_user_method_array: { deprecated: '4.1', removed: '7.0', replacement: 'call_user_func_array()' },
  set_magic_quotes_runtime: { deprecated: '5.3', removed: '7.0', replacement: null },
  magic_quotes_runtime: { deprecated: '5.3', removed: '7.0', replacement: null },
  set_socket_blocking: { deprecated: '5.3', removed: '7.0', replacement: 'stream_set_blocking()' },
  mysql_connect: { deprecated: '5.5', removed: '7.0', replacement: 'mysqli_* or PDO' },
  mysql_query: { deprecated: '5.5', removed: '7.0', replacement: 'mysqli_* or PDO' },
  mysql_select_db: { deprecated: '5.5', removed: '7.0', replacement: 'mysqli_* or PDO' },
  mysql_fetch_array: { deprecated: '5.5', removed: '7.0', replacement: 'mysqli_* or PDO' },

  // ---- 7.2 ----
  each: { deprecated: '7.2', removed: '8.0', replacement: 'foreach' },
  create_function: { deprecated: '7.2', removed: '8.0', replacement: 'anonymous function' },
  __autoload: { deprecated: '7.2', removed: '8.0', replacement: 'spl_autoload_register()' },
  gmp_random: { deprecated: '7.2', removed: '8.0', replacement: 'gmp_random_range()' },
  read_exif_data: { deprecated: '7.2', removed: null, replacement: 'exif_read_data()' },

  // ---- 7.3 ----
  image2wbmp: { deprecated: '7.3', removed: '8.0', replacement: 'imagewbmp()' },
  fgetss: { deprecated: '7.3', removed: '8.0', replacement: null },
  gzgetss: { deprecated: '7.3', removed: '8.0', replacement: null },

  // ---- 7.4 ----
  get_magic_quotes_gpc: { deprecated: '7.4', removed: '8.0', replacement: null },
  get_magic_quotes_runtime: { deprecated: '7.4', removed: '8.0', replacement: null },
  money_format: { deprecated: '7.4', removed: '8.0', replacement: 'NumberFormatter::formatCurrency()' },
  restore_include_path: { deprecated: '7.4', removed: '8.0', replacement: "ini_restore('include_path')" },
  hebrevc: { deprecated: '7.4', removed: '8.3', replacement: 'nl2br(hebrev())' },
  convert_cyr_string: { deprecated: '7.4', removed: '8.0', replacement: 'mb_convert_encoding()' },
  ezmlm_hash: { deprecated: '7.4', removed: '8.0', replacement: null },

  // ---- 8.0 ----
  libxml_disable_entity_loader: { deprecated: '8.0', removed: null, replacement: 'no longer needed' },

  // ---- 8.1 ----
  strptime: { deprecated: '8.1', removed: null, replacement: 'date_parse_from_format() / IntlDateFormatter' },
  date_sunrise: { deprecated: '8.1', removed: null, replacement: 'date_sun_info()' },
  date_sunset: { deprecated: '8.1', removed: null, replacement: 'date_sun_info()' },
  mhash: { deprecated: '8.1', removed: null, replacement: 'hash()' },
  mhash_keygen_s2k: { deprecated: '8.1', removed: null, replacement: 'hash_hkdf()' },
  utf8_encode: { deprecated: '8.2', removed: null, replacement: 'mb_convert_encoding()' },
  utf8_decode: { deprecated: '8.2', removed: null, replacement: 'mb_convert_encoding()' },

  // ---- 8.3 ----
  // (mostly constant/behavioral; function-level ones are above)

  // ---- 8.4 ----
  mysqli_ping: { deprecated: '8.4', removed: null, replacement: 'automatic reconnection' },
  mysqli_kill: { deprecated: '8.4', removed: null, replacement: null },
  mysqli_refresh: { deprecated: '8.4', removed: null, replacement: null },
  session_set_save_handler: { deprecated: '8.4', removed: null, replacement: 'object signature form' },
};

// Deprecated constants (flagged when used as a `name` reference).
export const PHP_DEPRECATED_CONSTANTS = {
  FILTER_SANITIZE_STRING: { deprecated: '8.1', removed: null, replacement: 'htmlspecialchars() / explicit sanitization' },
  FILTER_FLAG_SCHEME_REQUIRED: { deprecated: '7.3', removed: '8.0', replacement: null },
  FILTER_FLAG_HOST_REQUIRED: { deprecated: '7.3', removed: '8.0', replacement: null },
  ENT_HTML401: { deprecated: null, removed: null, replacement: null }, // placeholder-safe
  MB_OVERLOAD_MAIL: { deprecated: '7.2', removed: '8.0', replacement: null },
  MB_OVERLOAD_STRING: { deprecated: '7.2', removed: '8.0', replacement: null },
  MB_OVERLOAD_REGEX: { deprecated: '7.2', removed: '8.0', replacement: null },
};

export const PHP_VERSIONS = ['7.0', '7.1', '7.2', '7.3', '7.4', '8.0', '8.1', '8.2', '8.3', '8.4'];

// Compare dotted versions: returns -1, 0, 1.
export function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
