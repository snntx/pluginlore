<?php
/**
 * Plugin Name: Pluginlore Trace (staging, or live with caution)
 * Description: Records which plugin and theme files load for each request (AJAX, REST, admin-post, pages) so Pluginlore can overlay real runtime paths on its static graph. Best on a staging site; on a live site use it with caution and switch it off when you are done.
 * Version: 0.1.0
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 *
 * Recording is OFF until you add this to wp-config.php:
 *     define( 'PLUGINLORE_TRACE', true );
 * Then use your site normally and export the log from Tools → Pluginlore Trace.
 * Nothing is ever sent anywhere; the log stays in this site's database until
 * you download or clear it. It stores only the page path (no query string), the
 * request method, whether the visitor was logged in, and which files loaded, for
 * the last 500 requests. Best on a staging site; on a live site it adds one
 * database write per request, so switch it off when you are done.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const PLUGINLORE_TRACE_OPTION = 'pluginlore_trace_log';
const PLUGINLORE_TRACE_MAX    = 500; // keep only the most recent N requests

function pluginlore_trace_enabled() {
	return defined( 'PLUGINLORE_TRACE' ) && PLUGINLORE_TRACE;
}

/**
 * Classify the current request: [ kind, target ].
 */
function pluginlore_trace_request_info() {
	$script = isset( $_SERVER['SCRIPT_NAME'] ) ? basename( wp_unslash( $_SERVER['SCRIPT_NAME'] ) ) : '';
	// phpcs:disable WordPress.Security.NonceVerification -- read-only classification, no action taken.
	$action = isset( $_REQUEST['action'] ) ? sanitize_key( wp_unslash( $_REQUEST['action'] ) ) : '';
	// phpcs:enable

	if ( wp_doing_ajax() ) {
		return array( 'ajax', $action );
	}
	if ( 'admin-post.php' === $script ) {
		return array( 'admin-post', $action );
	}
	if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
		$route = isset( $GLOBALS['wp']->query_vars['rest_route'] ) ? (string) $GLOBALS['wp']->query_vars['rest_route'] : '';
		return array( 'rest', preg_replace( '#[^A-Za-z0-9/_\-\.]#', '', $route ) );
	}
	if ( wp_doing_cron() ) {
		return array( 'cron', '' );
	}
	if ( is_admin() ) {
		global $pagenow;
		return array( 'admin', (string) $pagenow );
	}
	$uri = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '/';
	$path = (string) wp_parse_url( $uri, PHP_URL_PATH );
	return array( 'page', preg_replace( '#[^A-Za-z0-9/_\-\.]#', '', $path ) );
}

/**
 * At the end of every request, record the plugin/theme files PHP loaded.
 */
function pluginlore_trace_record() {
	if ( ! pluginlore_trace_enabled() ) {
		return;
	}
	// Don't record our own export/clear requests.
	// phpcs:ignore WordPress.Security.NonceVerification
	if ( isset( $_REQUEST['action'] ) && 0 === strpos( (string) $_REQUEST['action'], 'pluginlore_trace_' ) ) {
		return;
	}

	$roots = array(
		wp_normalize_path( WP_PLUGIN_DIR ) . '/',
		wp_normalize_path( get_theme_root() ) . '/',
	);
	$self  = wp_normalize_path( __FILE__ );
	$files = array();
	foreach ( get_included_files() as $file ) {
		$file = wp_normalize_path( $file );
		if ( $file === $self ) {
			continue;
		}
		foreach ( $roots as $root ) {
			if ( 0 === strpos( $file, $root ) ) {
				$files[] = substr( $file, strlen( $root ) );
				break;
			}
		}
	}
	if ( ! $files ) {
		return;
	}

	list( $kind, $target ) = pluginlore_trace_request_info();
	$log   = get_option( PLUGINLORE_TRACE_OPTION, array() );
	$log   = is_array( $log ) ? $log : array();
	$log[] = array(
		't'         => time(),
		'kind'      => $kind,
		'target'    => $target,
		'method'    => isset( $_SERVER['REQUEST_METHOD'] ) ? sanitize_key( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) : 'get',
		'logged_in' => is_user_logged_in(),
		'files'     => array_values( array_unique( $files ) ),
	);
	if ( count( $log ) > PLUGINLORE_TRACE_MAX ) {
		$log = array_slice( $log, -PLUGINLORE_TRACE_MAX );
	}
	update_option( PLUGINLORE_TRACE_OPTION, $log, false ); // never autoloaded
}
add_action( 'shutdown', 'pluginlore_trace_record', PHP_INT_MAX );

/**
 * Tools → Pluginlore Trace.
 */
function pluginlore_trace_menu() {
	add_management_page( 'Pluginlore Trace', 'Pluginlore Trace', 'manage_options', 'pluginlore-trace', 'pluginlore_trace_page' );
}
add_action( 'admin_menu', 'pluginlore_trace_menu' );

function pluginlore_trace_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'You do not have permission to view this page.' ) );
	}
	$log = get_option( PLUGINLORE_TRACE_OPTION, array() );
	$n   = is_array( $log ) ? count( $log ) : 0;
	?>
	<div class="wrap">
		<h1>Pluginlore Trace</h1>
		<?php if ( ! pluginlore_trace_enabled() ) : ?>
			<div class="notice notice-warning inline"><p>
				Not recording. Add <code>define( 'PLUGINLORE_TRACE', true );</code> to <code>wp-config.php</code> on a staging site (or a live site, with caution).
			</p></div>
		<?php else : ?>
			<div class="notice notice-success inline"><p>Recording. Use the site (click buttons, submit forms, load pages), then export.</p></div>
		<?php endif; ?>
		<p><?php echo esc_html( sprintf( '%d request(s) recorded (most recent %d kept).', $n, PLUGINLORE_TRACE_MAX ) ); ?></p>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block;margin-right:8px">
			<input type="hidden" name="action" value="pluginlore_trace_download" />
			<?php wp_nonce_field( 'pluginlore_trace_download' ); ?>
			<?php submit_button( 'Download trace (.json)', 'primary', 'submit', false ); ?>
		</form>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block">
			<input type="hidden" name="action" value="pluginlore_trace_clear" />
			<?php wp_nonce_field( 'pluginlore_trace_clear' ); ?>
			<?php submit_button( 'Clear log', 'secondary', 'submit', false ); ?>
		</form>
		<p class="description">Then open Pluginlore, load the same plugin zip, and use <strong>Runtime trace → Import</strong>.</p>
	</div>
	<?php
}

function pluginlore_trace_download() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'You do not have permission to do this.' ), 403 );
	}
	check_admin_referer( 'pluginlore_trace_download' );
	$log = get_option( PLUGINLORE_TRACE_OPTION, array() );
	nocache_headers();
	header( 'Content-Type: application/json; charset=utf-8' );
	header( 'Content-Disposition: attachment; filename="pluginlore-trace-' . gmdate( 'Ymd-His' ) . '.json"' );
	echo wp_json_encode(
		array(
			'tool'      => 'pluginlore-trace',
			'version'   => 1,
			'generated' => gmdate( 'c' ),
			'wp'        => get_bloginfo( 'version' ),
			'php'       => PHP_VERSION,
			'requests'  => is_array( $log ) ? $log : array(),
		)
	);
	exit;
}
add_action( 'admin_post_pluginlore_trace_download', 'pluginlore_trace_download' );

function pluginlore_trace_clear() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'You do not have permission to do this.' ), 403 );
	}
	check_admin_referer( 'pluginlore_trace_clear' );
	delete_option( PLUGINLORE_TRACE_OPTION );
	wp_safe_redirect( admin_url( 'tools.php?page=pluginlore-trace' ) );
	exit;
}
add_action( 'admin_post_pluginlore_trace_clear', 'pluginlore_trace_clear' );

register_uninstall_hook( __FILE__, 'pluginlore_trace_uninstall' );
function pluginlore_trace_uninstall() {
	delete_option( PLUGINLORE_TRACE_OPTION );
}
