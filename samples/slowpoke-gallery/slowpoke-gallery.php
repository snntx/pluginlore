<?php
/**
 * Plugin Name: Slowpoke Gallery (Pluginlore tutorial)
 * Description: Practice plugin full of performance traps.
 * Version: 1.2.0
 */
if ( ! defined( 'ABSPATH' ) ) exit;

add_shortcode( 'slowpoke_gallery', 'spg_render' );

function spg_render() {
	global $wpdb;
	$html  = '';
	// Loads every attachment on the site, every page view.
	$items = get_posts( array( 'post_type' => 'attachment', 'posts_per_page' => -1 ) );

	foreach ( $items as $item ) {
		// One query per image (N+1).
		$likes = $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}spg_likes WHERE image_id = %d", $item->ID ) );
		// A whole WP_Query per image.
		$related = new WP_Query( array( 'post_parent' => $item->ID ) );
		// An external HTTP request per image -- the slowest of all.
		$exif = wp_remote_get( 'https://example.com/exif/' . $item->ID );
		$html .= '<figure>' . esc_html( $item->post_title ) . ' (' . (int) $likes . ')</figure>';
	}
	return $html;
}

function spg_photographers() {
	$out = array();
	foreach ( get_users( array( 'number' => -1 ) ) as $user ) {
		$out[] = get_posts( array( 'author' => $user->ID, 'numberposts' => 5 ) );
	}
	return $out;
}
