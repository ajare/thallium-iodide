import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { configSchema } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import type { Runner, CommandResult } from '../src/process.js';
const ok = (output = ''): CommandResult => ({ code: 0, output, timedOut: false, truncated: false });
async function fixture(state = 'exited', execute?: Runner, createdState = 'running') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tower-monitor-'));
  for (const script of ['start.sh', 'stop.sh']) await writeFile(path.join(directory, script), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const calls: string[] = [];
  const config = configSchema.parse({ scriptsDirectory: directory, resources: [{ id: 'ai', name: 'AI', containerName: 'ai', startScript: 'start.sh', stopScript: 'stop.sh' }] });
  const runner: Runner = async (command, args, timeout, cwd) => {
    if (command === 'podman' && args[0] === 'ps') return ok(JSON.stringify(state === 'missing' ? [] : [{ Names: ['ai'], State: state }]));
    calls.push(command === 'podman' ? `podman ${args.join(' ')}` : path.basename(command));
    const result = execute ? await execute(command, args, timeout, cwd) :
      command === 'podman' && state === 'missing' ? { ...ok('no such container'), code: 125 } : ok('command output');
    if (result.code === 0 && !result.timedOut) {
      if (command === 'podman') state = args[0] === 'stop' ? 'exited' : 'running';
      else state = path.basename(command) === 'start.sh' ? createdState : 'missing';
    }
    return result;
  };
  const monitor = new Monitor(config, runner); await monitor.refresh();
  return { monitor, calls, config, setState: (value: string) => { state = value; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('UI URLs are included in initial and refreshed dashboard state', async () => {
  const config = configSchema.parse({ scriptsDirectory: '/opt/scripts', resources: [
    { id: 'ui', name: 'UI', containerName: 'ui', uiUrl: 'http://127.0.0.1:9999/' },
    { id: 'api', name: 'API', containerName: 'api' }
  ] });
  const monitor = new Monitor(config, async () => ok('[]'));
  const urls = () => monitor.data().resources.map(resource => resource.uiUrl);
  assert.deepEqual(urls(), ['http://127.0.0.1:9999/', null]);
  await monitor.refresh();
  assert.deepEqual(urls(), ['http://127.0.0.1:9999/', null]);
});

test('existing stopped container starts via Podman without executing creation script', async () => {
  const f = await fixture('exited');
  try {
    assert.equal((await f.monitor.act('ai', 'start', false)).state, 'succeeded');
    assert.deepEqual(f.calls, ['podman start ai']);
    assert.equal(f.monitor.snapshots[0].lifecycle, 'running');
  } finally { await f.cleanup(); }
});

test('existing containers can start, stop and restart without either script configured', async () => {
  const f = await fixture('exited');
  try {
    f.config.resources[0].startScript = null; f.config.resources[0].stopScript = null;
    await f.monitor.refresh();
    assert.deepEqual(f.monitor.snapshots[0].availableActions, ['start', 'restart']);
    assert.deepEqual(f.monitor.snapshots[0].configurationErrors, []);
    await f.monitor.act('ai', 'start', false);
    await f.monitor.act('ai', 'stop', true);
    await f.monitor.act('ai', 'restart', true);
    assert.deepEqual(f.calls, ['podman start ai', 'podman stop ai', 'podman stop ai', 'podman start ai']);
  } finally { await f.cleanup(); }
});

test('missing containers are created by scripts, not Podman start', async () => {
  const f = await fixture('missing');
  try {
    assert.deepEqual(f.monitor.snapshots[0].availableActions, ['start']);
    assert.equal((await f.monitor.act('ai', 'start', false)).state, 'succeeded');
    assert.deepEqual(f.calls, ['start.sh']);
    assert.equal(f.monitor.snapshots[0].lifecycle, 'running');
    assert.equal(f.monitor.snapshots[0].readiness, 'unknown');
  } finally { await f.cleanup(); }
});

test('successful creation of a stopped container is followed by Podman start', async () => {
  const f = await fixture('missing', undefined, 'exited');
  try {
    const result = await f.monitor.act('ai', 'start', false);
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(f.calls, ['start.sh', 'podman start ai']);
    assert.equal(f.monitor.snapshots[0].lifecycle, 'running');
  } finally { await f.cleanup(); }
});

test('successful script that leaves the configured container missing is reported as failure', async () => {
  const f = await fixture('missing', undefined, 'missing');
  try {
    const result = await f.monitor.act('ai', 'start', false);
    assert.equal(result.state, 'failed'); assert.match(result.error!, /state is missing/);
    assert.deepEqual(f.calls, ['start.sh']);
  } finally { await f.cleanup(); }
});

test('missing container requires a valid creation script', async () => {
  const f = await fixture('missing');
  try {
    f.config.resources[0].startScript = null; await f.monitor.refresh();
    assert.deepEqual(f.monitor.snapshots[0].availableActions, []);
    await assert.rejects(f.monitor.act('ai', 'start', false), /unavailable/);
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test('creation failure falls back to starting the configured name and retains script output', async () => {
  const f = await fixture('missing', async command => command === 'podman' ? ok('started ai') : { ...ok('name already exists'), code: 125 });
  try {
    const result = await f.monitor.act('ai', 'start', false);
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(f.calls, ['start.sh', 'podman start ai']);
    assert.match(result.output, /name already exists/); assert.match(result.output, /started ai/);
    assert.equal(f.monitor.snapshots[0].lifecycle, 'running');
  } finally { await f.cleanup(); }
});

test('creation and fallback failures remain visible and are not retried', async () => {
  const f = await fixture('missing', async command => ({ ...ok(command === 'podman' ? 'no such container' : 'creation failed'), code: 125 }));
  try {
    const result = await f.monitor.act('ai', 'start', false);
    assert.equal(result.state, 'failed'); assert.match(result.output, /creation failed/); assert.match(result.output, /no such container/);
    assert.deepEqual(f.calls, ['start.sh', 'podman start ai']);
  } finally { await f.cleanup(); }
});

test('restart is confirmed Podman stop then start, never destructive scripts', async () => {
  const f = await fixture('running');
  try {
    await assert.rejects(f.monitor.act('ai', 'start', false), /unavailable/);
    await assert.rejects(f.monitor.act('ai', 'restart', false), /confirmation/);
    assert.equal((await f.monitor.act('ai', 'restart', true)).state, 'succeeded');
    assert.deepEqual(f.calls, ['podman stop ai', 'podman start ai']);
  } finally { await f.cleanup(); }
});

test('failed Podman stop aborts restart and captures output', async () => {
  const f = await fixture('running', async () => ({ ...ok('stop error'), code: 2 }));
  try {
    const result = await f.monitor.act('ai', 'restart', true);
    assert.equal(result.state, 'failed'); assert.match(result.error!, /code 2/);
    assert.match(result.output, /stop error/); assert.deepEqual(f.calls, ['podman stop ai']);
  } finally { await f.cleanup(); }
});

test('creation timeout fails without Podman fallback or retries', async () => {
  const f = await fixture('missing', async () => ({ ...ok('partial output'), code: null, timedOut: true }));
  try {
    const result = await f.monitor.act('ai', 'start', false);
    assert.equal(result.state, 'failed'); assert.match(result.error!, /timed out/);
    assert.deepEqual(f.calls, ['start.sh']);
  } finally { await f.cleanup(); }
});

test('blocks overlapping actions and releases lock after completion', async () => {
  let release!: (value: CommandResult) => void;
  const f = await fixture('exited', () => new Promise(resolve => { release = resolve; }));
  try {
    const action = f.monitor.act('ai', 'start', false);
    await assert.rejects(f.monitor.act('ai', 'start', false), /already running/);
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(f.monitor.data().resources[0].availableActions, []);
    release(ok()); await action;
    assert.equal(f.monitor.data().resources[0].lastAction?.state, 'succeeded');
    assert.deepEqual(f.monitor.data().resources[0].availableActions, ['stop', 'restart']);
  } finally { await f.cleanup(); }
});

test('Podman failures are unknown, never missing, and disable lifecycle actions', async () => {
  const config = configSchema.parse({ scriptsDirectory: '/absent', resources: [{ id: 'ai', name: 'AI', containerName: 'ai' }] });
  const monitor = new Monitor(config, async () => { throw new Error('permission denied'); });
  await monitor.refresh();
  assert.equal(monitor.snapshots[0].lifecycle, 'unknown');
  assert.deepEqual(monitor.snapshots[0].availableActions, []);
  assert.equal(monitor.podmanError, 'permission denied');
});

test('liveness and readiness are independent and only probe running containers', async () => {
  const requests: string[] = [];
  const server = http.createServer((req, res) => { requests.push(req.url!); res.writeHead(req.url === '/live' ? 200 : 503); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const f = await fixture('running');
  try {
    f.config.resources[0].liveness = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/live`, timeoutMs: 1000 };
    f.config.resources[0].readiness = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/ready`, timeoutMs: 1000 };
    await f.monitor.refresh();
    assert.equal(f.monitor.snapshots[0].lifecycle, 'running');
    assert.equal(f.monitor.snapshots[0].liveness, 'healthy');
    assert.equal(f.monitor.snapshots[0].readiness, 'unhealthy');
    assert.match(f.monitor.snapshots[0].detail, /Liveness HTTP 200; Readiness HTTP 503/);
    assert.deepEqual(requests, ['/live', '/ready']);
    f.config.resources[0].liveness.url = f.config.resources[0].readiness.url;
    f.config.resources[0].readiness.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/live`;
    await f.monitor.refresh();
    assert.equal(f.monitor.snapshots[0].liveness, 'unhealthy');
    assert.equal(f.monitor.snapshots[0].readiness, 'healthy');
    f.setState('exited');
    await f.monitor.refresh();
    assert.equal(f.monitor.snapshots[0].liveness, 'unknown');
    assert.equal(f.monitor.snapshots[0].readiness, 'unknown');
    assert.equal(requests.length, 4);
  } finally { await f.cleanup(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
