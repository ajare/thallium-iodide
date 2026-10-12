import { spawn, type ChildProcess } from 'node:child_process';

const children = new Set<ChildProcess>();
function terminate(child: ChildProcess) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch { /* Process already exited. */ }
}
export function terminateCommands() { for (const child of children) terminate(child); }

export type CommandResult = { code: number | null; output: string; timedOut: boolean; truncated: boolean };
export type Runner = (command: string, args: string[], timeoutMs: number, cwd?: string) => Promise<CommandResult>;
export const OUTPUT_LIMIT = 64 * 1024;

// Scripts run in their own process group so timeout also terminates their descendants.
export const run: Runner = (command, args, timeoutMs, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '', timedOut = false, truncated = false;
  const append = (chunk: string) => {
    if (output.length + chunk.length > OUTPUT_LIMIT) truncated = true;
    output = (output + chunk).slice(-OUTPUT_LIMIT);
  };
  child.stdout.setEncoding('utf8').on('data', append);
  child.stderr.setEncoding('utf8').on('data', append);
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, timeoutMs);
  child.on('error', error => { children.delete(child); clearTimeout(timer); reject(error); });
  child.on('close', code => { children.delete(child); clearTimeout(timer); resolve({ code, output, timedOut, truncated }); });
});
