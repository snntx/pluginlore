<?php
if (!defined('ABSPATH')) exit;
class Sample_Base {
  public function run() { return 'base'; }
  public function render() { echo 'base render'; }
}
