<?php
/**
 * Plugin Name: Sample Plugin
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) exit;

require_once __DIR__ . '/includes/class-base.php';
require_once plugin_dir_path(__FILE__) . 'includes/class-handler.php';

add_action('wp_ajax_nopriv_sample_save', 'sample_save_handler');
add_action('wp_ajax_sample_save', 'sample_save_handler');
add_shortcode('sample', 'sample_shortcode');
register_rest_route('sample/v1', '/item', array(
  'methods' => 'POST',
  'callback' => 'sample_rest_item',
  'permission_callback' => '__return_true',
));

function sample_save_handler() {
  global $wpdb;
  $id = $_POST['id'];
  $wpdb->query("DELETE FROM wp_items WHERE id = " . $id);
  echo $_POST['name'];
}

function sample_shortcode($atts) {
  return '<button id="save" class="sample-btn">Save</button>';
}

function sample_rest_item($req) {
  return array('ok' => true);
}

add_action('wp_enqueue_scripts', function () {
  wp_enqueue_script('sample-app', plugins_url('js/app.js', __FILE__), array('jquery'), '1.0', true);
  wp_enqueue_style('sample-css', plugins_url('css/style.css', __FILE__));
});
