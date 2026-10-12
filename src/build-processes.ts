import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DEFAULT_MONITORED_PROCESSES } from './config.js';

const execute = promisify(execFile);
export type BuildProcess = {
  pid: number; command: string; startedAt: string; elapsedSeconds: number;
  cpuPercent: number; memoryPercent: number; memoryBytes: number;
};

export function parseBuildProcesses(output: string, names: string[] = DEFAULT_MONITORED_PROCESSES): BuildProcess[] {
  const patterns = names.map(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return ['gcc', 'g++'].includes(name)
      ? new RegExp(`^(?:[\\w.+]+-)*${escaped}(?:-\\d+(?:\\.\\d+)*)?$`)
      : new RegExp(`^${escaped}$`);
  });
  const processes: BuildProcess[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, pid, comm, started, elapsed, cpu, memory, rss, command] = match;
    const executable = command.split(/\s+/)[0].split('/').pop()!;
    if (!patterns.some(pattern => pattern.test(comm) || pattern.test(executable))) continue;
    const startedAt = new Date(started);
    if (Number.isNaN(startedAt.getTime())) continue;
    processes.push({ pid: Number(pid), command, startedAt: startedAt.toISOString(), elapsedSeconds: Number(elapsed),
      cpuPercent: Number(cpu), memoryPercent: Number(memory), memoryBytes: Number(rss) * 1024 });
  }
  return processes.sort((a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid);
}

export async function scanBuildProcesses(names: string[] = DEFAULT_MONITORED_PROCESSES): Promise<BuildProcess[]> {
  if (!names.length) return [];
  const { stdout } = await execute('ps', ['-eo', 'pid=,comm=,lstart=,etimes=,pcpu=,pmem=,rss=,args='], {
    env: { ...process.env, LC_ALL: 'C' }, timeout: 5000, maxBuffer: 16 * 1024 * 1024
  });
  return parseBuildProcesses(stdout, names);
}
