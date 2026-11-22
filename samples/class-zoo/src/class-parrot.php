<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class Zoo_Parrot extends Zoo_Base_Animal {
	use Zoo_Noisy;

	public function speak() {
		return 'Hello';
	}

	public function describe() {
		return 'A parrot repeating: ' . $this->speak();
	}
}
