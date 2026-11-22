<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class LCF_Messages {
	public static function delete( $id ) {
		global $wpdb;
		$wpdb->delete( $wpdb->prefix . 'lcf_messages', array( 'id' => $id ) );
	}

	public static function all() {
		global $wpdb;
		return $wpdb->get_results( "SELECT * FROM {$wpdb->prefix}lcf_messages" );
	}
}
