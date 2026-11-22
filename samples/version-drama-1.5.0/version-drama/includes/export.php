<?php
if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'wp_ajax_nopriv_vd_download', 'vd_download' );
add_action( 'wp_ajax_vd_download', 'vd_download' );
function vd_download() {
	global $wpdb;
	$id  = absint( $_GET['id'] );
	$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}vd_files WHERE id = %d", $id ) );
	wp_send_json( $row );
}
