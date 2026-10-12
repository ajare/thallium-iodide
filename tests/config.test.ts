import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema, loadConfig, resolveScript } from '../src/config.js';

test('validates allowlisted resource IDs, names, script paths and unique mappings', () => {
  const base = { scriptsDirectory: '/opt/container-scripts', resources: [{ id: 'ai', name: 'AI', containerName: 'ai' }] };
  assert.equal(configSchema.parse(base).actionTimeoutMs, 120000);
  assert.equal(configSchema.parse(base).resources[0].liveness, null);
  const probes = configSchema.parse({ ...base, resources: [{ ...base.resources[0], liveness: { url: 'http://localhost/live' }, readiness: { url: 'http://localhost/ready' } }] }).resources[0];
  assert.equal(probes.liveness?.timeoutMs, 3000);
  assert.equal(probes.readiness?.url, 'http://localhost/ready');
  for (const scriptsDirectory of ['scripts', './scripts', '~/scripts', '']) {
    assert.equal(configSchema.safeParse({ ...base, scriptsDirectory }).success, false);
  }
  for (const override of [{ startScript: '../escape' }, { startScript: '/bin/sh' }, { containerName: '--help' }, { id: '../bad' }, { readiness: { url: 'file:///etc/passwd' } }, { liveness: { url: 'file:///etc/passwd' } }, { liveness: { url: 'http://localhost', timeoutMs: 0 } }]) {
    assert.equal(configSchema.safeParse({ ...base, resources: [{ ...base.resources[0], ...override }] }).success, false);
  }
  assert.equal(configSchema.safeParse({ ...base, resources: [base.resources[0], base.resources[0]] }).success, false);
  assert.equal(configSchema.safeParse({ ...base, resources: [base.resources[0], { ...base.resources[0], id: 'other' }] }).success, false);
});

test('UI URLs are optional and accept only HTTP(S) links', () => {
  const resource = { id: 'ai', name: 'AI' };
  const parse = (extra: object = {}) => configSchema.safeParse({ scriptsDirectory: '/opt/scripts', resources: [{ ...resource, ...extra }] });
  const omitted = parse();
  assert.ok(omitted.success);
  assert.equal(omitted.data.resources[0].uiUrl, null);
  for (const uiUrl of [null, 'http://127.0.0.1:9999/', 'https://example.com/ui']) assert.ok(parse({ uiUrl }).success);
  for (const uiUrl of ['', '/ui', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com']) assert.equal(parse({ uiUrl }).success, false);
});

test('resolves scripts inside directory, rejects symlink escapes and non-executables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tower-config-'));
  try {
    await writeFile(path.join(root, 'start.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    assert.equal(await resolveScript(root, 'start.sh'), path.join(root, 'start.sh'));
    await symlink('/bin/sh', path.join(root, 'escape.sh'));
    await assert.rejects(resolveScript(root, 'escape.sh'), /inside/);
    await writeFile(path.join(root, 'not-executable'), 'echo hi', { mode: 0o600 });
    await assert.rejects(resolveScript(root, 'not-executable'));
    await writeFile(path.join(root, 'config.json'), JSON.stringify({ scriptsDirectory: root, resources: [{ id: 'ai', name: 'AI' }] }));
    assert.equal((await loadConfig(path.join(root, 'config.json'))).scriptsDirectory, root);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('monitored process names default, allow empty lists and reject invalid names', () => {
  const base = { scriptsDirectory: '/opt/scripts', resources: [{ id: 'ai', name: 'AI' }] };
  assert.deepEqual(configSchema.parse(base).monitoredProcesses, ['ctest', 'cmake', 'gcc', 'g++']);
  for (const monitoredProcesses of [[], ['node', 'gcc-14', 'g++']]) {
    assert.deepEqual(configSchema.parse({ ...base, monitoredProcesses }).monitoredProcesses, monitoredProcesses);
  }
  for (const monitoredProcesses of [[''], ['/usr/bin/gcc'], ['gcc.*'], ['two words'], ['gcc', 'gcc'], ['--help']]) {
    assert.equal(configSchema.safeParse({ ...base, monitoredProcesses }).success, false);
  }
});
