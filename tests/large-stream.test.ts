import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { createServer } from '../src/server.js';
import { scanFiles } from '../src/files.js';

test('large recent file tails stay connected after delivering initial output', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tower-large-tail-'));
  const fixture = path.join(root, 'session.jsonl');
  await writeFile(fixture, JSON.stringify({ text: 'x'.repeat(70000) }) + '\n');
  const filename = process.env.TAIL_REPRO_FILE ?? fixture;
  const config = configSchema.parse({ scriptsDirectory: root, monitoredPaths: [filename], resources: [{ id: 'ai', name: 'AI' }] });
  const monitor = new Monitor(config);
  const server = createServer(monitor, 'dist/public');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const { files } = await scanFiles(config.monitoredPaths);
    assert.equal(files.length, 1);
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/files/${files[0].id}/logs`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const original = await readFile(filename, 'utf8');
    const lines = original.split('\n');
    const endsWithNewline = original.endsWith('\n');
    if (endsWithNewline) lines.pop();
    const expectedLength = (lines.slice(-200).join('\n') + (endsWithNewline ? '\n' : '')).length;
    let receivedLength = 0;
    let pending = '';
    const decoder = new TextDecoder();
    // A quiet tail must remain open, not cause EventSource's disconnected message.
    const drain = (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return 'disconnected';
        pending += decoder.decode(chunk.value, { stream: true });
        const frames = pending.split('\n\n'); pending = frames.pop()!;
        for (const frame of frames) {
          if (frame.startsWith('event: log\ndata: ')) receivedLength += (JSON.parse(frame.slice('event: log\ndata: '.length)) as string).length;
        }
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([drain, new Promise<string>(resolve => { timer = setTimeout(() => resolve('connected'), 300); })]);
    clearTimeout(timer);
    assert.equal(result, 'connected', 'tail closed prematurely: browser would show Disconnected or unavailable');
    controller.abort(); await drain.catch(() => {});
    assert.equal(receivedLength, expectedLength, 'backpressure must not drop any of the recent tail');
  } finally {
    controller.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
