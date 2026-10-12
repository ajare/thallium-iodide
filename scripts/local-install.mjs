import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'local-ai-control-tower';
const markerName = '.local-install.json';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function exists(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed (${code})`)));
  });
}

export function locations({ prefix = path.join(os.homedir(), '.local'), configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config') } = {}) {
  if (!path.isAbsolute(prefix) || !path.isAbsolute(configHome)) throw new Error('Prefix and configuration home must be absolute paths.');
  prefix = path.resolve(prefix);
  return {
    prefix,
    app: path.join(prefix, 'share', name),
    launcher: path.join(prefix, 'bin', name),
    config: path.join(configHome, name, 'config.json')
  };
}

async function ownedInstallation(paths) {
  const info = await exists(paths.app);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing to modify unowned path: ${paths.app}`);
  let marker;
  try { marker = JSON.parse(await readFile(path.join(paths.app, markerName), 'utf8')); }
  catch { throw new Error(`Refusing to modify installation without ownership marker: ${paths.app}`); }
  if (marker.name !== name || marker.app !== paths.app || marker.launcher !== paths.launcher || typeof marker.launcherContent !== 'string') {
    throw new Error(`Invalid installation marker: ${paths.app}`);
  }
  return marker;
}

async function checkLauncher(paths, marker) {
  const info = await exists(paths.launcher);
  if (!info) return;
  if (!marker || !info.isFile() || info.isSymbolicLink() || await readFile(paths.launcher, 'utf8') !== marker.launcherContent) {
    throw new Error(`Refusing to overwrite or remove unrelated launcher: ${paths.launcher}`);
  }
}

export async function installLocal(options = {}) {
  const paths = locations(options);
  const root = options.sourceRoot || sourceRoot;
  if (path.resolve(root) === paths.app) throw new Error('Install updates from a source checkout, not the installed application.');
  const previous = await ownedInstallation(paths);
  await checkLauncher(paths, previous);
  const execute = options.run || run;
  await execute('npm', ['run', 'build'], root);
  await mkdir(path.dirname(paths.app), { recursive: true });
  const stage = await mkdtemp(path.join(path.dirname(paths.app), `.${name}-`));
  try {
    for (const filename of ['package.json', 'package-lock.json', 'config.example.json']) {
      await copyFile(path.join(root, filename), path.join(stage, filename));
    }
    await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
    await mkdir(path.join(stage, 'scripts'));
    await copyFile(path.join(root, 'scripts/local-install.mjs'), path.join(stage, 'scripts/local-install.mjs'));
    await execute('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
    const launcherContent = `#!/bin/sh\n# Installed by ${name}; do not edit.\nif [ "$#" -eq 1 ] && [ "$1" = "--uninstall" ]; then\n  exec ${quote(process.execPath)} ${quote(path.join(paths.app, 'scripts/local-install.mjs'))} uninstall --prefix ${quote(paths.prefix)}\nfi\ncd ${quote(paths.app)} || exit 1\nif [ -z "\${CONFIG_PATH:-}" ]; then\n  CONFIG_PATH=${quote(paths.config)}\nfi\nexport CONFIG_PATH\nexec ${quote(process.execPath)} dist/server/index.js "$@"\n`;
    const marker = { name, app: paths.app, launcher: paths.launcher, config: paths.config, launcherContent };
    await writeFile(path.join(stage, markerName), JSON.stringify(marker, null, 2));
    await mkdir(path.dirname(paths.config), { recursive: true, mode: 0o700 });
    try { await copyFile(options.config || path.join(root, 'config.example.json'), paths.config, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await mkdir(path.dirname(paths.launcher), { recursive: true });
    // Recheck ownership after the build before replacing an existing installation.
    await checkLauncher(paths, await ownedInstallation(paths));
    if (previous) await rm(paths.app, { recursive: true });
    await rename(stage, paths.app);
    await writeFile(paths.launcher, launcherContent, { mode: 0o755 });
    return paths;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function uninstallLocal(options = {}) {
  const paths = locations(options);
  const marker = await ownedInstallation(paths);
  await checkLauncher(paths, marker);
  if (!marker) return { ...paths, removed: false };
  await rm(paths.launcher, { force: true });
  await rm(paths.app, { recursive: true });
  return { ...paths, config: marker.config, removed: true };
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === '--help' || args.includes('--help')) {
    console.log('Usage: node scripts/local-install.mjs install|uninstall [--prefix /absolute/path] [--config /path/to/config.json]\nDefault prefix: ~/.local. Configuration is preserved on uninstall. --config is install-only.');
    return;
  }
  if (!['install', 'uninstall'].includes(action)) throw new Error('Expected install or uninstall; use --help for usage.');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!['--prefix', '--config'].includes(flag) || !value || value.startsWith('--') || (flag === '--config' && action !== 'install')) throw new Error(`Invalid option: ${flag}`);
    options[flag.slice(2)] = flag === '--config' ? path.resolve(value) : value;
  }
  if (process.platform === 'win32') throw new Error('Local installation requires a POSIX host (Linux/macOS).');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const result = action === 'install' ? await installLocal(options) : await uninstallLocal(options);
  console.log(action === 'install' ? `Installed: ${result.launcher}\nEdit configuration: ${result.config}\nThen run: ${result.launcher}\nAdd ${path.dirname(result.launcher)} to PATH if needed.` : `${result.removed ? 'Uninstalled' : 'Not installed'}. Configuration preserved: ${result.config}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
