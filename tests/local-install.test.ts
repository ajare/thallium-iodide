import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink, lstat, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { installLocal, uninstallLocal, locations } from '../scripts/local-install.mjs';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tower-install-'$ "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  await mkdir(path.join(sourceRoot, 'dist/server'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'dist/public'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'scripts'));
  await writeFile(path.join(sourceRoot, 'dist/server/index.js'), 'console.log(JSON.stringify({cwd: process.cwd(), config: process.env.CONFIG_PATH}));');
  await writeFile(path.join(sourceRoot, 'dist/public/index.html'), '<html>dashboard</html>');
  for (const file of ['package.json', 'package-lock.json', 'config.example.json']) await writeFile(path.join(sourceRoot, file), '{}');
  await copyFile('scripts/local-install.mjs', path.join(sourceRoot, 'scripts/local-install.mjs'));
  const calls: string[][] = [];
  const options = { sourceRoot, prefix: path.join(root, 'prefix'), configHome: path.join(root, 'config'), run: async (command: string, args: string[]) => { calls.push([command, ...args]); } };
  return { root, options, calls, paths: locations(options) };
}

test('local install builds runtime, launches from any directory, updates without replacing config, and uninstalls safely', async t => {
  const { options, paths, calls, root } = await fixture(t);
  await installLocal(options);
  assert.deepEqual(calls, [['npm', 'run', 'build'], ['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']]);
  assert.equal((await lstat(paths.launcher)).mode & 0o111, 0o111);
  await access(path.join(paths.app, 'dist/public/index.html'));
  const env = { ...process.env }; delete env.CONFIG_PATH;
  const launched = JSON.parse(execFileSync(paths.launcher, [], { cwd: root, env, encoding: 'utf8' }));
  assert.deepEqual(launched, { cwd: paths.app, config: paths.config });
  const override = JSON.parse(execFileSync(paths.launcher, [], { env: { ...env, CONFIG_PATH: '/custom/config.json' }, encoding: 'utf8' }));
  assert.equal(override.config, '/custom/config.json');
  await writeFile(paths.config, '{"user":"settings"}');
  await installLocal(options);
  assert.equal(await readFile(paths.config, 'utf8'), '{"user":"settings"}');
  const unrelated = path.join(options.prefix, 'share/other-app');
  await writeFile(unrelated, 'keep');
  const result = await uninstallLocal(options);
  assert.equal(result.removed, true);
  await assert.rejects(access(paths.app));
  await assert.rejects(access(paths.launcher));
  assert.equal(await readFile(paths.config, 'utf8'), '{"user":"settings"}');
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  assert.equal((await uninstallLocal(options)).removed, false);
});

test('installed launcher can uninstall without the source checkout', async t => {
  const { options, paths } = await fixture(t);
  await installLocal(options);
  await rm(options.sourceRoot, { recursive: true });
  execFileSync(paths.launcher, ['--uninstall']);
  await assert.rejects(access(paths.app));
  await assert.rejects(access(paths.launcher));
  await access(paths.config);
});

test('explicit config seeds first install only', async t => {
  const { options, paths, root } = await fixture(t);
  const config = path.join(root, 'existing.json');
  await writeFile(config, '{"custom":true}');
  await installLocal({ ...options, config });
  assert.equal(await readFile(paths.config, 'utf8'), '{"custom":true}');
  await writeFile(config, '{"custom":false}');
  await installLocal({ ...options, config });
  assert.equal(await readFile(paths.config, 'utf8'), '{"custom":true}');
});

test('unowned directories, symlinks, and modified launchers are never removed', async t => {
  const { options, paths, root } = await fixture(t);
  await mkdir(paths.app, { recursive: true });
  await assert.rejects(installLocal(options), /ownership marker/);
  await assert.rejects(uninstallLocal(options), /ownership marker/);
  await rm(paths.app, { recursive: true });
  await symlink(root, paths.app);
  await assert.rejects(uninstallLocal(options), /unowned path/);
  await rm(paths.app);
  await mkdir(path.dirname(paths.launcher), { recursive: true });
  await writeFile(paths.launcher, 'unrelated');
  await assert.rejects(installLocal(options), /unrelated launcher/);
  await assert.rejects(uninstallLocal(options), /unrelated launcher/);
  await rm(paths.launcher);
  await installLocal(options);
  await writeFile(paths.launcher, 'modified');
  await assert.rejects(uninstallLocal(options), /unrelated launcher/);
  await assert.rejects(installLocal(options), /unrelated launcher/);
  await access(paths.app);
});

test('failed dependency installation leaves existing installation usable', async t => {
  const { options, paths } = await fixture(t);
  await installLocal(options);
  const launcher = await readFile(paths.launcher, 'utf8');
  await assert.rejects(installLocal({ ...options, run: async (_command: string, args: string[]) => { if (args[0] === 'ci') throw new Error('dependency failure'); } }), /dependency failure/);
  assert.equal(await readFile(paths.launcher, 'utf8'), launcher);
  await access(path.join(paths.app, 'dist/server/index.js'));
});

test('installation locations reject relative prefixes and configuration homes', () => {
  assert.throws(() => locations({ prefix: 'relative' }), /absolute/);
  assert.throws(() => locations({ configHome: '~/config' }), /absolute/);
});
