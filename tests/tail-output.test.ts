import test from 'node:test';
import assert from 'node:assert/strict';
import { TailOutput } from '../web/tail-output.js';

test('pretty-prints complete JSON documents including documents split across chunks', () => {
  const output = new TailOutput('/logs/result.json');
  assert.equal(output.append('{"nested":'), '{"nested":');
  assert.equal(output.append('{"ok":true},"items":[1,2]}\n'), JSON.stringify({ nested: { ok: true }, items: [1, 2] }, null, 2));
  assert.equal(output.append('invalid'), '{"nested":{"ok":true},"items":[1,2]}\ninvalid');
  output.clear();
  assert.equal(output.append('null'), 'null');
  output.clear();
  assert.equal(output.append('false'), 'false');
});

test('pretty-prints each JSONL record without feeding formatted text back into the stream', () => {
  const output = new TailOutput('/logs/events.jsonl');
  const first = JSON.stringify({ a: 1 }, null, 2);
  assert.equal(output.append('{"a":1}\n{"b":'), first + '\n{"b":');
  assert.equal(output.append('2}\nnot json\n\n'), first + '\n' + JSON.stringify({ b: 2 }, null, 2) + '\nnot json\n\n');
  assert.equal(output.append('{"html":"<script>"}\r\n'), first + '\n' + JSON.stringify({ b: 2 }, null, 2) + '\nnot json\n\n' + JSON.stringify({ html: '<script>' }, null, 2) + '\n');
});

test('leaves other output raw, handles uppercase extensions and resets after clear', () => {
  assert.equal(new TailOutput('/logs/plain.log').append('{"a":1}\n'), '{"a":1}\n');
  assert.equal(new TailOutput().append('{"a":1}\n'), '{"a":1}\n');
  const output = new TailOutput('/logs/RESULT.JSONL');
  output.append('{"partial":'); output.clear();
  assert.equal(output.append('{"new":true}'), JSON.stringify({ new: true }, null, 2));
});

test('bounds raw and pretty-printed output', () => {
  const output = new TailOutput('/logs/big.jsonl');
  const text = output.append('{"long":"' + 'x'.repeat(200000) + '"}\n');
  assert.ok(text.length <= 128 * 1024);
  output.clear();
  const lines = output.append(Array.from({ length: 1500 }, (_, i) => JSON.stringify({ i })).join('\n'));
  assert.ok(lines.length <= 128 * 1024);
  assert.ok(lines.split('\n').length <= 1000);
  assert.ok(lines.includes('1499'));
});
