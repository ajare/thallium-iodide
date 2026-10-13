import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { createServer } from '../src/server.js';
import { findTerminalEmulator } from '../src/terminal.js';

test('findTerminalEmulator prefers xdg-terminal-exec and falls back through the list', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'terminal-test-'));
  assert.equal(await findTerminalEmulator(directory), null);
  const xterm = path.join(directory, 'xterm');
  await writeFile(xterm, '#!/bin/sh\n');
  await chmod(xterm, 0o755);
  assert.deepEqual(await findTerminalEmulator(directory), { command: xterm, arguments: ['-e'] });
  const xdg = path.join(directory, 'xdg-terminal-exec');
  await writeFile(xdg, '#!/bin/sh\n');
  await chmod(xdg, 0o755);
  assert.deepEqual(await findTerminalEmulator(directory), { command: xdg, arguments: [] });
});

test('terminal endpoint requires a token and a running container, and opens a terminal', async () => {
  const monitor = new Monitor(configSchema.parse({ scriptsDirectory: '/absent', resources: [
    { id: 'ai', name: 'AI', containerName: 'ai' },
    { id: 'db', name: 'DB', containerName: 'db' }
  ] }), async () => ({ code: 0, output: '[{"Names":["ai"],"State":"running"}]', timedOut: false, truncated: false }));
  await monitor.refresh();
  const opened: string[] = [];
  const server = createServer(monitor, 'dist/public', undefined, undefined, async name => { opened.push(name); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const { token, localClient } = await (await fetch(`${base}/api/state`)).json() as { token: string; localClient: boolean };
    // The test server is reached over loopback, so the terminal column is offered.
    assert.equal(localClient, true);
    const endpoint = `${base}/api/resources/ai/terminal`;
    assert.equal((await fetch(endpoint, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/api/resources/unknown/terminal`, { method: 'POST', headers: { 'X-Control-Token': token } })).status, 404);
    // db exists but is missing (not running): terminal is refused.
    assert.equal((await fetch(`${base}/api/resources/db/terminal`, { method: 'POST', headers: { 'X-Control-Token': token } })).status, 409);
    const response = await fetch(endpoint, { method: 'POST', headers: { 'X-Control-Token': token } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(opened, ['ai']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
