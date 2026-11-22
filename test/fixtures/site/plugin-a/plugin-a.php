<?php
/**
 * Plugin Name: Plugin A
 * Version: 2.0.1
 */
if (!defined('ABSPATH')) exit;

function helper_format($v) { return trim($v); }

function plugin_a_list() {
  global $wpdb;
  $posts = get_posts(array('post_type' => 'post', 'posts_per_page' => -1));
  foreach ($posts as $p) {
    $meta = $wpdb->get_results("SELECT * FROM wp_postmeta WHERE post_id = " . (int) $p->ID);
    $q = new WP_Query(array('p' => $p->ID));
  }
}
