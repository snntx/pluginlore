<?php
if ( ! defined( 'ABSPATH' ) ) exit;

trait Zoo_Noisy {
	public function shout() {
		return strtoupper( $this->speak() ) . '!';
	}
}
