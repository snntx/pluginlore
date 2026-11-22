<?php
/**
 * Plugin Name: Class Zoo (Pluginlore tutorial)
 * Description: Practice plugin for structure: includes, interfaces, traits, inheritance and overrides.
 * Version: 2.1.0
 */
if ( ! defined( 'ABSPATH' ) ) exit;

require_once __DIR__ . '/src/interface-animal.php';
require_once __DIR__ . '/src/trait-noisy.php';
require_once __DIR__ . '/src/abstract-animal.php';
require_once __DIR__ . '/src/class-lion.php';
require_once __DIR__ . '/src/class-parrot.php';
require_once __DIR__ . '/src/helpers.php';

add_action( 'init', 'zoo_register' );

function zoo_tour() {
	foreach ( array( new Zoo_Lion(), new Zoo_Parrot() ) as $animal ) {
		zoo_log( $animal->describe() );
	}
}
