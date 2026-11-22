<?php
/**
 * Plugin Name: Plugin B
 * Version: 0.9
 */
if (!defined('ABSPATH')) exit;

function helper_format($v) { return strtolower($v); }

if (!class_exists('Shared_Logger')) {
  class Shared_Logger { public function log($m) {} }
}
