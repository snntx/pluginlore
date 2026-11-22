// The PHP we send into the in-browser WordPress must at least be valid PHP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Parser from 'php-parser';
import { callScript, activateScript, parseResult, stepChunks, RESULT_MARKER } from '../web/src/harness.js';

let php = null;
try { execFileSync('php', ['-v'], { stdio: 'ignore' }); php = 'php'; } catch {}

// Real `php -l` when available, otherwise the bundled PHP parser in strict mode.
const strict = new Parser.Engine({ parser: { suppressErrors: false, php8: true }, ast: { withPositions: false } });
const lint = (code) => {
  if (!php) { strict.parseCode(code, 'x.php'); return 'No syntax errors detected'; }
  const dir = mkdtempSync(join(tmpdir(), 'sl-'));
  const f = join(dir, 'x.php');
  writeFileSync(f, code);
  return execFileSync(php, ['-l', f], { encoding: 'utf8' });
};

test('generated PHP is syntactically valid', () => {
  assert.match(lint(callScript({ fn: 'lcf_submit', args: [{ kind: 'text', value: "O'Brien <b>\"x\"</b> ünïcode" }], as: 'admin', skipNonce: true, ajax: true })), /No syntax errors/);
  assert.match(lint(callScript({ fn: 'delete', cls: 'LCF_Messages', args: [] })), /No syntax errors/);
  assert.match(lint(activateScript({ kind: 'plugin', plugins: ['x/x.php'] })), /No syntax errors/);
});

test('arguments are embedded as data, never as code', () => {
  const evil = "'); system('id'); //";
  const code = callScript({ fn: 'f', args: [{ kind: 'text', value: evil }] });
  assert.ok(!code.includes(evil), 'raw argument text must not appear in the PHP source');
  const b64 = code.match(/base64_decode\('([A-Za-z0-9+/=]+)'\)/)[1];
  assert.equal(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).args[0].value, evil);
});

test('result parsing and per-step output', () => {
  const result = { output: 'AB<p>C</p>', steps: [{ hook: 'init', at: 0 }, { hook: 'the_content', at: 2 }] };
  const { result: r } = parseResult(`noise${RESULT_MARKER}${JSON.stringify(result)}`);
  const steps = stepChunks(r);
  assert.equal(steps[0].output, 'AB');
  assert.equal(steps[1].output, '<p>C</p>');
});
