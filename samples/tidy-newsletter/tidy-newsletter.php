<?php
/**
 * Plugin Name: Tidy Newsletter (Pluginlore tutorial)
 * Description: Practice plugin that does things properly, for contrast.
 * Version: 4.0.0
 */
if ( ! defined( 'ABSPATH' ) ) exit;

require_once __DIR__ . '/includes/class-tn-subscribers.php';

add_action( 'wp_enqueue_scripts', function () {
	wp_enqueue_script( 'tn-signup', plugins_url( 'assets/signup.js', __FILE__ ), array(), '4.0.0', true );
} );

// Public signup: writing is intended here, guarded by a nonce and sanitised input.
add_action( 'wp_ajax_nopriv_tn_subscribe', 'tn_subscribe' );
add_action( 'wp_ajax_tn_subscribe', 'tn_subscribe' );
function tn_subscribe() {
	check_ajax_referer( 'tn_subscribe' );
	$email = sanitize_email( wp_unslash( $_POST['email'] ) );
	TN_Subscribers::add( $email );
	wp_send_json_success( array( 'message' => esc_html__( 'Thanks for subscribing!' ) ) );
}

// Admin-only removal: nonce + capability.
add_action( 'wp_ajax_tn_remove', 'tn_remove' );
function tn_remove() {
	check_ajax_referer( 'tn_remove' );
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( -1, 403 );
	}
	TN_Subscribers::remove( absint( $_POST['id'] ) );
	wp_send_json_success();
}

add_action( 'rest_api_init', function () {
	register_rest_route( 'tidy/v1', '/subscribers', array(
		'methods'             => 'GET',
		'callback'            => array( 'TN_Subscribers', 'rest_list' ),
		'permission_callback' => function () {
			return current_user_can( 'manage_options' );
		},
	) );
} );

add_shortcode( 'tidy_signup', 'tn_render' );
function tn_render() {
	return '<form id="tn-form"><input type="email" name="email"><button class="tn-go">Subscribe</button></form>';
}
