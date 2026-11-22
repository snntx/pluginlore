<?php
/**
 * Plugin Name: Leaky Contact Form (Pluginlore tutorial)
 * Description: Practice plugin with deliberately broken access control. Never install it anywhere.
 * Version: 1.0.0
 */
if ( ! defined( 'ABSPATH' ) ) exit;

require_once __DIR__ . '/includes/class-lcf-messages.php';

// 1) Anyone can submit (fine) -- but there is no nonce, the query is built
//    from raw input (SQL injection) and the name is echoed back unescaped (XSS).
add_action( 'wp_ajax_nopriv_lcf_submit', 'lcf_submit' );
add_action( 'wp_ajax_lcf_submit', 'lcf_submit' );
function lcf_submit() {
	global $wpdb;
	$name = $_POST['name'];
	$wpdb->query( "INSERT INTO {$wpdb->prefix}lcf_messages (name) VALUES ('" . $name . "')" );
	echo 'Thanks, ' . $name;
	wp_die();
}

// 2) Logged-in only and has a nonce -- but no capability check, so any
//    Subscriber can delete every message.
add_action( 'wp_ajax_lcf_delete', 'lcf_delete' );
function lcf_delete() {
	check_ajax_referer( 'lcf_delete' );
	LCF_Messages::delete( absint( $_POST['id'] ) );
	wp_send_json_success();
}

// 3) The right way: nonce + capability before touching anything.
add_action( 'wp_ajax_lcf_export', 'lcf_export' );
function lcf_export() {
	check_ajax_referer( 'lcf_export' );
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( -1, 403 );
	}
	update_option( 'lcf_last_export', time() );
	wp_send_json( LCF_Messages::all() );
}

// 4) A REST route that is public AND destructive.
add_action( 'rest_api_init', function () {
	register_rest_route( 'lcf/v1', '/messages/(?P<id>\d+)', array(
		'methods'             => 'DELETE',
		'callback'            => 'lcf_rest_delete',
		'permission_callback' => '__return_true',
	) );
} );
function lcf_rest_delete( $request ) {
	wp_delete_post( (int) $request['id'], true );
	return array( 'deleted' => true );
}

add_shortcode( 'leaky_form', 'lcf_render_form' );
function lcf_render_form() {
	return '<form id="lcf-form" class="lcf"><input name="name"><button id="lcf-send">Send</button></form>';
}
