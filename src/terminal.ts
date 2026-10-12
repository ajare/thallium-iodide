import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Terminal emulators tried in order; the arguments introduce the command to run inside the window.
const TERMINALS: [string, string[]][] = [
  ['xdg-terminal-exec', []],
  ['ptyxis', ['--']],
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xterm', ['-e']]
];

export type TerminalEmulator = { command: string; arguments: string[] };

export async function findTerminalEmulator(pathVariable: string = process.env.PATH ?? ''): Promise<TerminalEmulator | null> {
  const directories = pathVariable.split(path.delimiter).filter(Boolean);
  for (const [command, args] of TERMINALS) {
    for (const directory of directories) {
      const candidate = path.join(directory, command);
      try {
        await access(candidate, constants.X_OK);
        return { command: candidate, arguments: args };
      } catch { /* keep looking */ }
    }
  }
  return null;
}

export async function containerShell(containerName: string): Promise<string> {
  try {
    const { stdout } = await execute('podman', ['exec', containerName, 'sh', '-c', 'command -v bash || command -v sh'], { timeout: 10000 });
    const shell = stdout.split('\n')[0].trim();
    if (/^\/[a-zA-Z0-9/_.-]+$/.test(shell)) return shell;
  } catch { /* fall back to sh below */ }
  return 'sh';
}

export async function openContainerTerminal(containerName: string): Promise<void> {
  const terminal = await findTerminalEmulator();
  if (!terminal) throw new Error(`No terminal emulator found on PATH (tried ${TERMINALS.map(([name]) => name).join(', ')})`);
  const shell = await containerShell(containerName);
  const child = spawn(terminal.command, [...terminal.arguments, 'podman', 'exec', '-it', containerName, shell], { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => resolve());
  });
  child.unref();
}
