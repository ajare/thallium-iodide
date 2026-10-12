import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeline } from '../web/timeline.js';

const entry = (message: object, extra: object = {}) => JSON.stringify({ type: 'message', id: 'e1', timestamp: '2026-10-11T17:16:40.000Z', ...extra, message });

test('splits assistant turns into inference events with model, stop reason and token usage', () => {
  const events = parseTimeline(entry({
    role: 'assistant', model: 'qwen-3.8-flash-next', stopReason: 'stop',
    usage: { input: 8714, output: 109 },
    content: [{ type: 'thinking', thinking: 'checking the repo' }, { type: 'text', text: 'Now I will read the code.' }]
  }));
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.kind, 'inference');
  assert.equal(event.title, 'qwen-3.8-flash-next');
  assert.equal(event.summary, 'Now I will read the code.');
  assert.deepEqual(event.meta, ['stop: stop', 'tokens in 8714 · out 109']);
  assert.ok(event.detail.includes('checking the repo'));
  assert.equal(event.at, Date.parse('2026-10-11T17:16:40.000Z'));
  assert.equal(event.endAt, null);
  assert.equal(event.error, false);
});

test('pairs tool calls with their results and records duration and errors', () => {
  const raw = [
    entry({ role: 'assistant', content: [
      { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'git status && ls' } }
    ] }),
    JSON.stringify({ type: 'message', id: 'e2', timestamp: '2026-10-11T17:16:42.500Z', message: {
      role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', isError: false,
      content: [{ type: 'text', text: 'clean tree' }]
    } }),
    entry({ role: 'assistant', content: [
      { type: 'toolCall', id: 'call_2', name: 'read', arguments: { path: '/src/main.ts' } }
    ] }),
    JSON.stringify({ type: 'message', id: 'e3', timestamp: '2026-10-11T17:16:41.000Z', message: {
      role: 'toolResult', toolCallId: 'call_2', toolName: 'read', isError: true,
      content: [{ type: 'text', text: 'file not found' }]
    } })
  ].join('\n');
  const events = parseTimeline(raw).filter(event => event.kind === 'tool');
  assert.equal(events.length, 2);
  assert.equal(events[0].title, 'bash');
  assert.equal(events[0].summary, 'git status && ls');
  assert.deepEqual(events[0].meta, ['2.5s']);
  assert.ok(events[0].detail.includes('"command": "git status && ls"'));
  assert.ok(events[0].detail.includes('clean tree'));
  assert.equal(events[0].error, false);
  assert.equal(events[1].title, 'read');
  assert.equal(events[1].summary, '/src/main.ts');
  assert.equal(events[1].error, true);
  assert.ok(events[1].meta.includes('error'));
  assert.ok(events[1].detail.includes('file not found'));
});

test('keeps file order so inference and tool events interleave chronologically', () => {
  const raw = [
    entry({ role: 'assistant', model: 'm', content: [{ type: 'text', text: 'first' }] }),
    entry({ role: 'assistant', model: 'm', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }] }),
    entry({ role: 'assistant', model: 'm', content: [{ type: 'text', text: 'last' }] })
  ].join('\n');
  const events = parseTimeline(raw);
  // A turn that only calls tools still counts as an inference turn, ordered before its tool events.
  assert.deepEqual(events.map(event => event.kind), ['inference', 'inference', 'tool', 'inference']);
  assert.equal(events[1].summary, 'Called bash');
});

test('skips partial and non-message lines so a split tail chunk parses once completed', () => {
  const partial = parseTimeline('{"type":"session","version":3}\n{"type":"message","message":{"role":"ass');
  assert.deepEqual(partial, []);
  const completed = parseTimeline('{"type":"session","version":3}\n' + entry({ role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done' }] }));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].kind, 'inference');
});

test('ignores unmatched tool results and turns without an assistant timestamp', () => {
  const raw = [
    JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'missing', toolName: 'bash', content: [{ type: 'text', text: 'orphan' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'no clock' }] } })
  ].join('\n');
  const events = parseTimeline(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].at, null);
});
