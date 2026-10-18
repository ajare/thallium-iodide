import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import { GitHubIssues, GitHubError } from '../src/github.js';
import { createServer } from '../src/server.js';

test('status aggregates containers, files, processes and cached GitHub tickets without control credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'status-api-'));
  const filename = path.join(root, 'job.log');
  await writeFile(filename, 'output\n');
  const config = configSchema.parse({ scriptsDirectory: root, monitoredPaths: [root], monitoredProcesses: ['cmake'],
    resources: [{ id: 'ai', name: 'AI', containerName: 'ai' }], github: { owner: 'owner', labels: ['work'] } });
  const monitor = new Monitor(config, async () => ({ code: 0, output: '[{"Names":["ai"],"State":"running"}]', timedOut: false, truncated: false }));
  await monitor.refresh();
  const process = { pid: 123, command: 'cmake --build .', startedAt: '2026-01-01T00:00:00.000Z', elapsedSeconds: 90,
    cpuPercent: 75, memoryPercent: 2, memoryBytes: 1048576 };
  let calls = 0;
  const github = new GitHubIssues(config.github, async endpoint => {
    calls++;
    return { hasNext: false, data: endpoint.startsWith('user/repos')
      ? [{ full_name: 'owner/repo', owner: { login: 'owner' }, archived: false }]
      : [{ number: 1, title: 'Ticket', body: 'Description', state: 'open', updated_at: '2026-01-01T00:00:00Z', labels: [{ name: 'work' }], assignees: [] }] };
  });
  const server = createServer(monitor, 'dist/public', undefined, async () => [process], undefined, github);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${base}/api/status`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.ok(Number.isFinite(Date.parse(data.generatedAt)));
    assert.equal(data.podmanError, null);
    assert.deepEqual(data.containers, [{ id: 'ai', name: 'AI', containerName: 'ai', status: 'running', liveness: 'unknown',
      readiness: 'unknown', checkedAt: monitor.snapshots[0].checkedAt, detail: 'No readiness check configured', configurationErrors: [] }]);
    assert.deepEqual(data.files.monitoredPaths, [root]);
    assert.deepEqual(data.files.errors, []);
    assert.equal(data.files.files.length, 1);
    assert.equal(data.files.files[0].path, filename);
    assert.equal(data.files.files[0].modifiedAt, (await stat(filename)).mtime.toISOString());
    assert.deepEqual(data.processes, { monitoredProcesses: ['cmake'], processes: [process], error: null });
    assert.equal(data.github.issues[0].title, 'Ticket');
    assert.equal(data.github.stale, false);
    assert.equal('token' in data, false);
    assert.equal('localClient' in data, false);
    await fetch(`${base}/api/status`);
    await fetch(`${base}/api/github`);
    assert.equal(calls, 2);
    assert.equal((await fetch(`${base}/api/status`, { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/status`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('status preserves other sections when Podman, processes and GitHub are unavailable', async () => {
  const config = configSchema.parse({ scriptsDirectory: '/absent', monitoredPaths: [], resources: [{ id: 'ai', name: 'AI', containerName: 'ai' }] });
  const monitor = new Monitor(config, async () => { throw new Error('Podman unavailable'); });
  await monitor.refresh();
  const github = new GitHubIssues(config.github, async () => { throw new GitHubError('GitHub unavailable'); });
  const server = createServer(monitor, 'dist/public', undefined, async () => { throw new Error('ps unavailable'); }, undefined, github);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/status`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.podmanError, 'Podman unavailable');
    assert.equal(data.containers[0].status, 'unknown');
    assert.deepEqual(data.files, { monitoredPaths: [], files: [], errors: [] });
    assert.equal(data.processes.processes, null);
    assert.equal(data.processes.error, 'ps unavailable');
    assert.equal(data.github.error, 'GitHub unavailable');
    assert.equal(data.github.stale, true);
    assert.equal(data.github.updatedAt, null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
