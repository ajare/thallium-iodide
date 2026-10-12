import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { configSchema } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { createServer } from '../src/server.js';

test('API enforces host, origin, token, content type and explicit confirmation', async () => {
  const monitor = new Monitor(configSchema.parse({ scriptsDirectory: '/absent', resources: [{ id: 'ai', name: 'AI', containerName: 'ai' }] }), async () => ({ code: 0, output: '[]', timedOut: false, truncated: false }));
  await monitor.refresh();
  const server = createServer(monitor, 'dist/public');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // Node fetch rewrites Host; use the HTTP client to actually exercise rebinding protection.
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.get(`${base}/api/state`, { headers: { Host: 'evil.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const response = await fetch(`${base}/api/state`);
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const data = await response.json() as { token: string };
    const endpoint = `${base}/api/resources/ai/actions`;
    const body = JSON.stringify({ action: 'restart' });
    assert.equal((await fetch(endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status, 403);
    const headers = { 'Content-Type': 'application/json', 'X-Control-Token': data.token };
    assert.equal((await fetch(endpoint, { method: 'POST', body, headers })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'POST', body, headers: { ...headers, 'X-Control-Token': 'é'.repeat(64) } })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{bad', headers })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'POST', body: JSON.stringify({ action: 'execute' }), headers })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'POST', body: 'x'.repeat(5000), headers })).status, 413);
    assert.equal((await fetch(`${base}/api/resources/ai/logs`)).status, 409);
    assert.equal((await fetch(`${base}/api/resources/unknown/logs`)).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('streams recent/live logs and kills the log process on browser disconnect', async () => {
  const monitor = new Monitor(configSchema.parse({ scriptsDirectory: '/absent', resources: [{ id: 'ai', name: 'AI', containerName: 'ai' }] }), async () => ({ code: 0, output: '[{"Names":["ai"],"State":"running"}]', timedOut: false, truncated: false }));
  await monitor.refresh();
  let child: ChildProcess | undefined;
  const server = createServer(monitor, 'dist/public', name => {
    assert.equal(name, 'ai');
    const process = spawn(globalThis.process.execPath, ['-e', "process.stdout.write('hello <script>\\n');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = process; return process;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/resources/ai/logs`, { signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('event: log')) {
      const chunk = await reader.read(); assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
    assert.match(text, /hello <script>/);
    const closed = new Promise<void>(resolve => child!.once('close', () => resolve()));
    controller.abort();
    await closed;
    assert.equal(child!.signalCode, 'SIGKILL');
  } finally { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
