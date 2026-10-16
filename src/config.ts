import { readFile, realpath, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_MONITORED_PROCESSES = ['ctest', 'cmake', 'gcc', 'g++'];

const script = z.string().min(1).refine(value => !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'), 'Script must be a relative path without traversal').nullable().default(null);
const probe = z.object({
  url: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'HTTP(S) only'),
  timeoutMs: z.number().int().min(100).max(30000).default(3000)
}).strict().nullable().default(null);
const resourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(100),
  containerName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).nullable().default(null),
  uiUrl: z.string().url().refine(value => /^https?:\/\//i.test(value), 'HTTP(S) only').nullable().default(null),
  startScript: script,
  stopScript: script,
  liveness: probe,
  readiness: probe
}).strict();
export const configSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4310),
  scriptsDirectory: z.string().min(1).refine(value => path.isAbsolute(value), 'scriptsDirectory must be an absolute path (for example /home/wm/scripts); ~ is not expanded'),
  pollIntervalMs: z.number().int().min(1000).max(60000).default(5000),
  actionTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  monitoredProcesses: z.array(z.string().min(1).max(100).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/, 'Use executable names, not paths or patterns')).max(100).refine(names => new Set(names).size === names.length, 'Duplicate monitored process names').default(DEFAULT_MONITORED_PROCESSES),
  monitoredPaths: z.array(z.string().min(1).refine(value => path.isAbsolute(value) && !value.includes('\0'), 'Monitored paths must be absolute; ~ is not expanded')).max(100).default([]),
  github: z.object({
    owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/).default('ajare'),
    labels: z.array(z.string().trim().min(1).max(100).refine(value => !/[\r\n\0]/.test(value), 'Invalid label')).max(20)
      .refine(labels => new Set(labels.map(label => label.toLowerCase())).size === labels.length, 'Duplicate GitHub labels')
      .default(['assignee:halogen/qwen-3.8-flash-next'])
  }).strict().default({}),
  resources: z.array(resourceSchema).min(1).max(100)
}).strict().superRefine((value, ctx) => {
  const ids = value.resources.map(r => r.id);
  const names = value.resources.flatMap(r => r.containerName ? [r.containerName] : []);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Duplicate resource IDs' });
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Duplicate container names' });
});
export type Config = z.infer<typeof configSchema>;
export type Resource = Config['resources'][number];

export async function loadConfig(filename: string): Promise<Config> {
  return configSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
}

export async function resolveScript(directory: string, filename: string): Promise<string> {
  const root = await realpath(directory);
  const target = await realpath(path.resolve(root, filename));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Script must remain inside the scripts directory');
  }
  if (!(await stat(target)).isFile()) throw new Error('Script is not a file');
  await access(target, constants.X_OK);
  return target;
}
