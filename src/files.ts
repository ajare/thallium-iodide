import { glob, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type MonitoredFile = { id: string; path: string; modifiedAt: string; modifiedMs: number };

// Skip symlink entries and never recurse through directory symlinks encountered during scans.
export async function scanFiles(patterns: string[]): Promise<{ files: MonitoredFile[]; errors: string[] }> {
  const files = new Map<string, MonitoredFile>();
  const errors: string[] = [];
  const directories = new Set<string>();
  async function collect(filename: string, recurse: boolean) {
    try {
      const info = await lstat(filename);
      if (info.isSymbolicLink()) return;
      if (info.isDirectory() && recurse) {
        if (directories.has(filename)) return;
        directories.add(filename);
        for (const entry of await readdir(filename)) await collect(path.join(filename, entry), true);
      } else if (info.isFile()) {
        const absolute = path.resolve(filename);
        files.set(absolute, { id: createHash('sha256').update(absolute).digest('hex'), path: absolute,
          modifiedAt: info.mtime.toISOString(), modifiedMs: info.mtimeMs });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${filename}: ${(error as Error).message}`);
    }
  }
  for (const pattern of patterns) {
    try {
      // Both literal and glob-matched directories include their regular-file descendants.
      try { await lstat(pattern); await collect(pattern, true); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for await (const filename of glob(pattern)) await collect(filename, true);
    } catch (error) { errors.push(`${pattern}: ${(error as Error).message}`); }
  }
  return { files: [...files.values()].sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path)), errors };
}
