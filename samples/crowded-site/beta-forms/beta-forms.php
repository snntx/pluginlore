<?php
/**
 * Plugin Name: Beta Forms (Pluginlore tutorial)
 * Version: 1.0.4
 */
if ( ! defined( 'ABSPATH' ) ) exit;

// Guarded: only declared if nobody else did. Safe.
if ( ! function_exists( 'site_breadcrumbs' ) ) {
	function site_breadcrumbs() {
		return '';
	}
}

if ( ! class_exists( 'Site_Cache' ) ) {
	class Site_Cache {
		public function get( $key ) { return get_transient( $key ); }
	}
}

// Not guarded: clashes with the theme below.
function format_phone( $number ) {
	return preg_replace( '/\D+/', '', $number );
}
