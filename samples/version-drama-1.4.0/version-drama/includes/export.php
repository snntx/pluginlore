<?php
if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'wp_ajax_nopriv_vd_download', 'vd_download' );
add_action( 'wp_ajax_vd_download', 'vd_download' );
function vd_download() {
	global $wpdb;
	$id  = $_GET['id'];
	$row = $wpdb->get_row( "SELECT * FROM {$wpdb->prefix}vd_files WHERE id = " . $id );
	wp_send_json( $row );
}
