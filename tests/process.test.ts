import test from 'node:test';
import assert from 'node:assert/strict';
import { run, OUTPUT_LIMIT } from '../src/process.js';

test('captures bounded output and reports exit failures', async () => {
  const result = await run(process.execPath, ['-e', `process.stdout.write('x'.repeat(${OUTPUT_LIMIT * 2})); process.exitCode=3`], 3000);
  assert.equal(result.code, 3); assert.equal(result.output.length, OUTPUT_LIMIT); assert.equal(result.truncated, true);
});

test('terminates timed-out process groups, including inherited output pipes', async () => {
  const started = Date.now();
  const result = await run('/bin/sh', ['-c', 'sleep 30 & wait'], 100);
  assert.equal(result.timedOut, true); assert.equal(result.code, null);
  assert.ok(Date.now() - started < 3000);
});

test('reports missing executables', async () => {
  await assert.rejects(run('/does-not-exist/tower-script', [], 1000), /ENOENT/);
});
