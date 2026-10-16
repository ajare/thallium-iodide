import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { Config } from './config.js';

export type GitHubIssue = {
  repository: string; number: number; title: string; body: string; url: string;
  labels: string[]; assignees: string[]; updatedAt: string;
};
export type GitHubSnapshot = {
  owner: string; labels: string[]; issues: GitHubIssue[]; updatedAt: string | null;
  lastSuccessAt: string | null; stale: boolean; partial: boolean; error: string | null; nextRefreshAt: string;
};
export type GitHubPage = { data: unknown; hasNext: boolean };
export type GitHubApi = (endpoint: string) => Promise<GitHubPage>;
export class GitHubError extends Error {
  constructor(message: string, public retryAt?: number, public stop = false) { super(message); }
}
const REFRESH_MS = 60000;
const MAX_PAGES = 100;

// Keep stdout separate from stderr: gh warnings must not corrupt JSON or expose credentials.
export const githubApi: GitHubApi = endpoint => new Promise((resolve, reject) => {
  execFile('gh', ['api', '--hostname', 'github.com', '--include', endpoint], {
    timeout: 20000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }
  }, (error, stdout) => {
    try { resolve(parseGitHubResponse(stdout, Boolean(error))); } catch (cause) { reject(cause); }
  });
});

export function parseGitHubResponse(stdout: string, failed = false, now = Date.now()): GitHubPage {
  const split = stdout.search(/\r?\n\r?\n/);
  const headers = split < 0 ? '' : stdout.slice(0, split);
  const status = Number(/^HTTP\/\S+\s+(\d+)/i.exec(headers)?.[1]);
  const header = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(headers)?.[1].trim();
  const retry = Number(header('retry-after'));
  const reset = Number(header('x-ratelimit-reset')) * 1000;
  if (status === 429 || (status === 403 && (header('x-ratelimit-remaining') === '0' || retry > 0 || /rate limit/i.test(stdout.slice(split))))) {
    throw new GitHubError('GitHub rate limit reached. Refresh will retry after the cooldown.', Math.max(now + 60000, retry > 0 ? now + retry * 1000 : reset || 0), true);
  }
  if (status === 401 || status === 403) throw new GitHubError('GitHub authentication or permission denied. Check gh auth status on the server.', undefined, true);
  if (failed || status !== 200) throw new GitHubError(status ? `GitHub request failed (HTTP ${status}).` : 'Unable to run gh api. Check that gh is installed, authenticated and can reach GitHub.', undefined, true);
  try {
    const body = stdout.slice(split).replace(/^\r?\n\r?\n/, '');
    return { data: JSON.parse(body), hasNext: /rel="next"/.test(header('link') ?? '') };
  } catch { throw new GitHubError('GitHub returned an invalid response.', undefined, true); }
}

const repositoriesSchema = z.array(z.object({
  full_name: z.string().regex(/^[\w-]+\/[\w.-]+$/), owner: z.object({ login: z.string() }), archived: z.boolean()
}));
const issuesSchema = z.array(z.object({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullable(),
  state: z.string(), updated_at: z.string().datetime(), pull_request: z.unknown().optional(),
  labels: z.array(z.object({ name: z.string() })), assignees: z.array(z.object({ login: z.string() }))
}));

export class GitHubIssues {
  private snapshot: GitHubSnapshot;
  private inFlight?: Promise<GitHubSnapshot>;
  private nextRefresh = 0;
  constructor(private config: Config['github'], private api: GitHubApi = githubApi, private now = Date.now) {
    this.snapshot = { ...config, issues: [], updatedAt: null, lastSuccessAt: null, stale: true, partial: false, error: null, nextRefreshAt: new Date(0).toISOString() };
  }
  get(): Promise<GitHubSnapshot> {
    if (this.inFlight) return this.inFlight;
    if (this.now() < this.nextRefresh) return Promise.resolve(this.snapshot);
    this.inFlight = this.refresh().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async refresh(): Promise<GitHubSnapshot> {
    const issues = new Map<string, GitHubIssue>();
    const repositories: string[] = [];
    let error: string | null = null;
    let retryAt = 0;
    const deadline = this.now() + 120000;
    const page = async (endpoint: string) => {
      if (this.now() >= deadline) throw new GitHubError('GitHub refresh exceeded two minutes; results are incomplete.', undefined, true);
      return this.api(endpoint);
    };
    const failure = (cause: unknown) => {
      const message = cause instanceof GitHubError ? cause.message : 'GitHub returned unexpected data; results are incomplete.';
      error ??= message;
      if (cause instanceof GitHubError) retryAt = Math.max(retryAt, cause.retryAt ?? 0);
    };
    try {
      if (this.config.labels.length) {
        // /users/:owner/repos only lists public repos. /user/repos includes every accessible
        // private repo and fork; filter by actual ownership, not collaborator membership.
        for (let index = 1; ; index++) {
          const response = await page(`user/repos?affiliation=owner,collaborator,organization_member&visibility=all&per_page=100&page=${index}`);
          for (const repo of repositoriesSchema.parse(response.data)) {
            if (repo.owner.login.toLowerCase() === this.config.owner.toLowerCase() && !repo.archived) repositories.push(repo.full_name);
          }
          if (!response.hasNext) break;
          if (index >= MAX_PAGES) throw new GitHubError('Repository pagination limit reached; results are incomplete.');
        }
        // Query each label separately: REST's comma-separated labels are AND, not OR.
        // Per-repository pagination avoids GitHub Search's 1,000-result ceiling entirely.
        for (const repository of new Set(repositories)) {
          for (const label of this.config.labels) {
            try {
              for (let index = 1; ; index++) {
                const response = await page(`repos/${repository}/issues?state=open&labels=${encodeURIComponent(label)}&sort=updated&direction=desc&per_page=100&page=${index}`);
                for (const issue of issuesSchema.parse(response.data)) {
                  if (issue.pull_request !== undefined || issue.state !== 'open' || !issue.labels.some(item => this.config.labels.some(label => label.toLowerCase() === item.name.toLowerCase()))) continue;
                  const key = `${repository}#${issue.number}`;
                  issues.set(key, { repository, number: issue.number, title: issue.title, body: issue.body ?? '',
                    url: `https://github.com/${repository}/issues/${issue.number}`, labels: issue.labels.map(item => item.name),
                    assignees: issue.assignees.map(item => item.login), updatedAt: issue.updated_at });
                }
                if (!response.hasNext) break;
                if (index >= MAX_PAGES) throw new GitHubError('Issue pagination limit reached; results are incomplete.');
              }
            } catch (cause) {
              failure(cause);
              if (cause instanceof GitHubError && cause.stop) throw cause;
            }
          }
        }
      }
    } catch (cause) { failure(cause); }
    const timestamp = new Date(this.now()).toISOString();
    this.nextRefresh = Math.max(this.now() + REFRESH_MS, retryAt);
    const sorted = [...issues.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.repository.localeCompare(b.repository) || a.number - b.number);
    // Never replace a complete successful snapshot with an incomplete refresh.
    const retain = error !== null && this.snapshot.updatedAt !== null;
    this.snapshot = {
      owner: this.config.owner, labels: this.config.labels,
      issues: retain ? this.snapshot.issues : sorted,
      updatedAt: retain ? this.snapshot.updatedAt : error && !issues.size ? null : timestamp,
      lastSuccessAt: error ? this.snapshot.lastSuccessAt : timestamp,
      stale: error !== null, partial: retain ? this.snapshot.partial : error !== null && issues.size > 0,
      error, nextRefreshAt: new Date(this.nextRefresh).toISOString()
    };
    return this.snapshot;
  }
}
