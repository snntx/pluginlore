<?php
if ( ! defined( 'ABSPATH' ) ) exit;

function zoo_register() {
	register_post_type( 'zoo_animal', array( 'public' => true ) );
}

function zoo_log( $message ) {
	error_log( '[zoo] ' . $message );
}
