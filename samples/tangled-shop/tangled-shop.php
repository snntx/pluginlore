<?php
/**
 * Plugin Name: Tangled Shop (Pluginlore tutorial)
 * Description: Practice plugin showing how front-end JavaScript talks to PHP.
 * Version: 0.3.0
 */
if ( ! defined( 'ABSPATH' ) ) exit;

require_once plugin_dir_path( __FILE__ ) . 'includes/cart.php';
require_once plugin_dir_path( __FILE__ ) . 'includes/render.php';

add_action( 'wp_enqueue_scripts', function () {
	wp_enqueue_script( 'ts-cart', plugins_url( 'assets/cart.js', __FILE__ ), array( 'jquery' ), '0.3.0', true );
	wp_enqueue_script( 'ts-wishlist', plugins_url( 'assets/wishlist.js', __FILE__ ), array(), '0.3.0', true );
	wp_enqueue_style( 'ts-style', plugins_url( 'assets/shop.css', __FILE__ ) );
	wp_localize_script( 'ts-cart', 'tsCart', array(
		'ajaxUrl' => admin_url( 'admin-ajax.php' ),
		'nonce'   => wp_create_nonce( 'ts_cart' ),
	) );
} );

add_shortcode( 'tangled_cart', 'ts_render_cart' );
