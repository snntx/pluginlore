<?php
if (!defined('ABSPATH')) exit;
if (!class_exists('Shared_Logger')) {
  class Shared_Logger { public function log($m) { error_log($m); } }
}
