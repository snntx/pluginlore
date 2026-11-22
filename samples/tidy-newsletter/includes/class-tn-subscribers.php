<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class TN_Subscribers {
	public static function add( $email ) {
		global $wpdb;
		$wpdb->insert( $wpdb->prefix . 'tn_subscribers', array( 'email' => $email ), array( '%s' ) );
	}

	public static function remove( $id ) {
		global $wpdb;
		$wpdb->delete( $wpdb->prefix . 'tn_subscribers', array( 'id' => $id ), array( '%d' ) );
	}

	public static function rest_list() {
		global $wpdb;
		return $wpdb->get_results( $wpdb->prepare( "SELECT email FROM {$wpdb->prefix}tn_subscribers LIMIT %d", 100 ) );
	}
}
