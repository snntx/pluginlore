<?php
if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'wp_ajax_vd_save_settings', 'vd_save_settings' );
function vd_save_settings() {
	check_ajax_referer( 'vd_settings' );
	update_option( 'vd_settings', sanitize_text_field( wp_unslash( $_POST['settings'] ) ) );
	wp_send_json_success();
}
