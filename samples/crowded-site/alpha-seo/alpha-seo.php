<?php
/**
 * Plugin Name: Alpha SEO (Pluginlore tutorial)
 * Version: 3.2.1
 */
if ( ! defined( 'ABSPATH' ) ) exit;

function site_breadcrumbs() {
	return '<nav class="crumbs">Home</nav>';
}

if ( ! class_exists( 'Site_Cache' ) ) {
	class Site_Cache {
		public function get( $key ) { return wp_cache_get( $key ); }
	}
}
