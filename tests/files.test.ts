import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanFiles } from '../src/files.js';
import { configSchema } from '../src/config.js';

test('monitored paths default empty and require absolute paths', () => {
  const base = { scriptsDirectory: '/scripts', resources: [{ id: 'ai', name: 'AI' }] };
  assert.deepEqual(configSchema.parse(base).monitoredPaths, []);
  assert.deepEqual(configSchema.parse({ ...base, monitoredPaths: ['/logs/**/*.log'] }).monitoredPaths, ['/logs/**/*.log']);
  for (const value of ['', 'logs/*.log', '~/logs', '/logs/\0bad']) {
    assert.equal(configSchema.safeParse({ ...base, monitoredPaths: [value] }).success, false);
  }
});

test('scans directories recursively, expands globs, deduplicates and orders by mtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tower-files-'));
  try {
    await mkdir(path.join(root, 'nested'));
    const old = path.join(root, 'old.log'); const latest = path.join(root, 'nested', 'new 1.log');
    const text = path.join(root, 'nested', 'other.txt');
    await writeFile(old, 'old'); await writeFile(latest, 'new'); await writeFile(text, 'text');
    await utimes(old, 1000, 1000); await utimes(text, 2000, 2000); await utimes(latest, 3000, 3000);
    await symlink(old, path.join(root, 'link.log'));
    await symlink(path.join(root, 'nested'), path.join(root, 'linked-directory'));
    const all = await scanFiles([root, old, path.join(root, '**/*.log')]);
    assert.deepEqual(all.errors, []);
    assert.deepEqual(all.files.map(f => f.path), [latest, text, old]);
    assert.equal(all.files[0].modifiedAt, new Date(3000000).toISOString());
    assert.match(all.files[0].id, /^[a-f0-9]{64}$/);
    const logs = await scanFiles([path.join(root, '**/*.log')]);
    assert.deepEqual(logs.files.map(f => f.path), [latest, old]);
    assert.equal(logs.files[0].id, all.files[0].id);
    assert.deepEqual((await scanFiles([path.join(root, 'nest*')])).files.map(f => f.path), [latest, text]);
    assert.deepEqual((await scanFiles([path.join(root, 'nested/new ?.log')])).files.map(f => f.path), [latest]);
    assert.deepEqual((await scanFiles([path.join(root, '[o]*.log')])).files.map(f => f.path), [old]);
    assert.deepEqual(await scanFiles([path.join(root, 'missing'), path.join(root, 'absent/*.log')]), { files: [], errors: [] });
    await writeFile(path.join(root, 'newly-created.log'), 'hello');
    assert.equal((await scanFiles([root])).files.length, 4);
    await rm(old);
    assert.equal((await scanFiles([root])).files.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
