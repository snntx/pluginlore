<?php
if ( ! defined( 'ABSPATH' ) ) exit;

// Not guarded: Alpha SEO declares this too -> "Cannot redeclare" fatal error.
function site_breadcrumbs() {
	return '<ol class="breadcrumbs"></ol>';
}

// Not guarded: Beta Forms declares this too.
function format_phone( $number ) {
	return trim( $number );
}
