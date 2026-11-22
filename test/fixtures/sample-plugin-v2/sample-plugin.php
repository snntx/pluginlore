<?php
/**
 * Plugin Name: Sample Plugin
 * Version: 1.1.0
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
  check_ajax_referer('sample_save');
  if (!current_user_can('manage_options')) wp_die();
  global $wpdb;
  $id = absint($_POST['id']);
  $wpdb->query($wpdb->prepare("DELETE FROM wp_items WHERE id = %d", $id));
  echo esc_html($_POST['name']);
}

add_action('wp_ajax_nopriv_sample_export', 'sample_export');
function sample_export() {
  update_option('sample_last_export', time());
  wp_send_json(get_option('sample_settings'));
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
