import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { createServer } from '../src/server.js';
import { scanFiles } from '../src/files.js';

test('file streams validate line limits, load selected history and follow live writes', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'file-line-limit-'));
  const filename = path.join(root, 'events.log');
  await writeFile(filename, Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const config = configSchema.parse({ scriptsDirectory: root, monitoredPaths: [filename], resources: [{ id: 'ai', name: 'AI' }] });
  const server = createServer(new Monitor(config), 'dist/public');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { files } = await scanFiles([filename]);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/files/${files[0].id}/logs`;
    for (const invalid of ['0', '-1', '1001', '1.5', 'abc', '']) {
      const response = await fetch(`${url}?lines=${invalid}`);
      assert.equal(response.status, 400);
      await response.text();
    }
    for (const count of [200, 50, 250]) {
      const controller = new AbortController();
      try {
        const response = await fetch(count === 200 ? url : `${url}?lines=${count}`, { signal: controller.signal });
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let pending = '', output = '';
        const readUntil = async (ending: string) => {
          while (!output.endsWith(ending)) {
            const chunk = await reader.read();
            assert.equal(chunk.done, false);
            pending += decoder.decode(chunk.value, { stream: true });
            const frames = pending.split('\n\n'); pending = frames.pop()!;
            for (const frame of frames) {
              if (frame.startsWith('event: log\ndata: ')) output += JSON.parse(frame.slice('event: log\ndata: '.length));
            }
          }
        };
        await readUntil('line 249\n');
        assert.equal(output, Array.from({ length: count }, (_, i) => `line ${250 - count + i}`).join('\n') + '\n');
        if (count === 250) {
          await appendFile(filename, 'live line\n');
          await readUntil('live line\n');
          assert.ok(output.endsWith('line 249\nlive line\n'));
        }
      } finally { controller.abort(); }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
