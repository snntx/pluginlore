<?php
if ( ! defined( 'ABSPATH' ) ) exit;

abstract class Zoo_Base_Animal implements Zoo_Animal {
	public function speak() {
		return '...';
	}

	public function describe() {
		return static::class . ' says ' . $this->speak();
	}
}
