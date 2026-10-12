import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configSchema } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { createServer } from '../src/server.js';
import type { MonitoredFile } from '../src/files.js';

test('lists configured files and streams recent and appended output with allowlist checks', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tower-file-api-'));
  const filename = path.join(root, 'a log; $(echo unsafe).log');
  await writeFile(filename, 'initial <script>\n');
  const monitor = new Monitor(configSchema.parse({ scriptsDirectory: root, monitoredPaths: [path.join(root, '*.log')], resources: [{ id: 'ai', name: 'AI' }] }));
  const server = createServer(monitor, 'dist/public');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${base}/api/files`, { headers: { Origin: 'http://evil.example' } })).status, 403);
    const list = await fetch(`${base}/api/files`);
    const data = await list.json() as { files: MonitoredFile[]; errors: string[] };
    assert.deepEqual(data.errors, []); assert.equal(data.files.length, 1);
    assert.equal(data.files[0].path, filename);
    assert.equal((await fetch(`${base}/api/files/${'0'.repeat(64)}/logs`)).status, 404);
    const endpoint = `${base}/api/files/${data.files[0].id}/logs`;
    const response = await fetch(endpoint, { signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body!.getReader(); let text = '';
    async function until(expected: string) {
      while (!text.includes(expected)) {
        const chunk = await reader.read(); assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
    }
    await until('initial <script>');
    await appendFile(filename, 'appended output\n');
    await until('appended output');
    controller.abort();
    await rm(filename);
    assert.equal((await fetch(endpoint)).status, 404);
    assert.deepEqual((await (await fetch(`${base}/api/files`)).json() as { files: MonitoredFile[] }).files, []);
  } finally {
    controller.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
