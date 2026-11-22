<?php
if ( ! defined( 'ABSPATH' ) ) exit;

function ts_render_cart() {
	ob_start();
	?>
	<div id="ts-cart" class="ts-panel">
		<span class="ts-count">0</span>
		<button id="ts-add" class="ts-btn" data-sku="mug">Add mug</button>
		<button class="ts-wish ts-btn">Wishlist</button>
	</div>
	<?php
	return ob_get_clean();
}
