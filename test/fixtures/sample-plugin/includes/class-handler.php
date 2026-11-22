<?php
if (!defined('ABSPATH')) exit;
class Sample_Handler extends Sample_Base {
  public function render() { echo 'child render'; }   // override
  public function process() {
    $cmd = $_GET['cmd'];
    system($cmd);                 // command injection pattern
    $data = unserialize($_COOKIE['blob']);  // object injection
    return split(',', $data);     // deprecated (removed 7.0)
  }
}
