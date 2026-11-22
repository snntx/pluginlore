<?php
if ( ! defined( 'ABSPATH' ) ) exit;

// Public "add to cart": guests can call it. It has a nonce, but nonces are
// handed to every visitor, so it is not an access control.
add_action( 'wp_ajax_ts_add_to_cart', 'ts_add_to_cart' );
add_action( 'wp_ajax_nopriv_ts_add_to_cart', 'ts_add_to_cart' );
function ts_add_to_cart() {
	check_ajax_referer( 'ts_cart', 'nonce' );
	$sku = sanitize_key( $_POST['sku'] );
	$qty = absint( $_POST['qty'] );
	set_transient( 'ts_cart_' . $sku, $qty, HOUR_IN_SECONDS );
	wp_send_json_success( array( 'count' => ts_cart_count() ) );
}

function ts_cart_count() {
	return 3;
}

add_action( 'rest_api_init', function () {
	register_rest_route( 'tangled/v1', '/wishlist', array(
		'methods'             => 'POST',
		'callback'            => 'ts_wishlist_save',
		'permission_callback' => function () {
			return is_user_logged_in();
		},
	) );
} );

function ts_wishlist_save( $request ) {
	update_user_meta( get_current_user_id(), 'ts_wishlist', $request->get_param( 'items' ) );
	return array( 'ok' => true );
}
