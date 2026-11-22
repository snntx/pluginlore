<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class Zoo_Lion extends Zoo_Base_Animal {
	use Zoo_Noisy;

	public function speak() {
		return 'Roar';
	}
}
