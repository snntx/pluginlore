<?php
if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'rest_api_init', function () {
	register_rest_route( 'vd/v1', '/webhook', array(
		'methods'             => 'POST',
		'callback'            => 'vd_webhook',
		'permission_callback' => '__return_true',
	) );
} );

function vd_webhook( $request ) {
	update_option( 'vd_last_webhook', $request->get_json_params() );
	return array( 'received' => true );
}
