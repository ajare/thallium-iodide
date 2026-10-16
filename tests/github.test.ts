import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { configSchema } from '../src/config.js';
import { GitHubIssues, GitHubError, parseGitHubResponse, type GitHubApi } from '../src/github.js';
import { Monitor } from '../src/monitor.js';
import { createServer } from '../src/server.js';

const config = (github: unknown = {}) => configSchema.parse({ scriptsDirectory: '/tmp', resources: [{ id: 'ai', name: 'AI' }], github });
const repo = (name: string, owner = 'ajare', archived = false) => ({ full_name: `${owner}/${name}`, owner: { login: owner }, archived, private: true, fork: true });
const issue = (number: number, labels = ['one'], extra = {}) => ({ number, title: `Issue ${number}`, body: 'Full description\n<script>alert(1)</script>', state: 'open', updated_at: '2026-01-01T00:00:00Z', labels: labels.map(name => ({ name })), assignees: [{ login: 'ajare' }], ...extra });
const page = (data: unknown, hasNext = false) => ({ data, hasNext });

test('CLI response parsing handles pagination, authentication, timeouts, malformed JSON and rate cooldowns', () => {
  assert.deepEqual(parseGitHubResponse('HTTP/2.0 200 OK\r\nLink: <https://api.github.com/x?page=2>; rel="next"\r\n\r\n[]'), page([], true));
  assert.deepEqual(parseGitHubResponse('HTTP/2.0 200 OK\n\n[]'), page([]));
  assert.throws(() => parseGitHubResponse('HTTP/2.0 200 OK\n\n[]', true), /request failed/);
  assert.throws(() => parseGitHubResponse('HTTP/2.0 200 OK\n\ninvalid'), /invalid response/);
  assert.throws(() => parseGitHubResponse(''), /installed, authenticated/);
  for (const status of [401, 403]) assert.throws(() => parseGitHubResponse(`HTTP/2.0 ${status} Denied\n\n{}`), /authentication or permission/);
  assert.throws(() => parseGitHubResponse('HTTP/2.0 403 Denied\nx-ratelimit-remaining: 0\nx-ratelimit-reset: 300\n\n{}', true, 1000), (error: unknown) => error instanceof GitHubError && error.retryAt === 300000 && error.stop);
  assert.throws(() => parseGitHubResponse('HTTP/2.0 429 Limited\nRetry-After: 120\n\n{}', true, 1000), (error: unknown) => error instanceof GitHubError && error.retryAt === 121000);
  assert.throws(() => parseGitHubResponse('HTTP/2.0 403 Denied\n\n{"message":"secondary rate limit"}', true, 1000), (error: unknown) => error instanceof GitHubError && error.retryAt === 61000);
});

test('GitHub configuration defaults, any-label lists, disabling and validation', () => {
  assert.deepEqual(config().github, { owner: 'ajare', labels: ['assignee:halogen/qwen-3.8-flash-next'] });
  assert.deepEqual(config({ labels: ['one', 'two'] }).github.labels, ['one', 'two']);
  assert.deepEqual(config({ labels: [] }).github.labels, []);
  for (const github of [{ owner: '../x' }, { labels: [''] }, { labels: ['one', 'ONE'] }, { labels: ['bad\nlabel'] }, { labels: ['a\0b'] }, { extra: true }]) assert.throws(() => config(github));
});

test('paginates owned repositories and issues, includes private forks, ORs labels, deduplicates and sorts', async () => {
  const calls: string[] = [];
  const api: GitHubApi = async endpoint => {
    calls.push(endpoint);
    if (endpoint.startsWith('user/repos')) return endpoint.endsWith('page=1')
      ? page([repo('fork'), repo('archived', 'ajare', true), repo('other', 'organization')], true)
      : page([repo('private', 'AJARE')]);
    if (endpoint.startsWith('repos/ajare/fork/issues')) {
      if (endpoint.includes('labels=one') && endpoint.endsWith('page=1')) return page([
        issue(1, ['ONE', 'two']), issue(2, ['one'], { pull_request: {} }), issue(3, ['one'], { state: 'closed' }), issue(4, ['wrong'])
      ], true);
      if (endpoint.includes('labels=one')) return page([issue(5)]);
      return page([issue(1, ['one', 'two']), issue(6, ['two'], { updated_at: '2026-02-01T00:00:00Z' })]);
    }
    assert.ok(endpoint.startsWith('repos/AJARE/private/issues'));
    return page([issue(7, ['two'], { body: null, updated_at: '2026-01-15T00:00:00Z' })]);
  };
  const service = new GitHubIssues(config({ labels: ['one', 'two'] }).github, api, () => 1000);
  const result = await service.get();
  assert.equal(result.error, null); assert.equal(result.partial, false); assert.equal(result.stale, false);
  assert.deepEqual(result.issues.map(item => item.number), [6, 7, 1, 5]);
  assert.equal(result.issues.find(item => item.number === 7)!.body, '');
  assert.equal(result.issues.find(item => item.number === 1)!.url, 'https://github.com/ajare/fork/issues/1');
  assert.deepEqual(result.issues[0].assignees, ['ajare']);
  assert.equal(calls.filter(call => call.startsWith('user/repos')).length, 2);
  assert.equal(calls.some(call => call.includes('/archived/') || call.includes('/other/')), false);
});

test('shares in-flight work and caches all requests, including manual refreshes, for 60 seconds', async () => {
  let now = 1000, calls = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const service = new GitHubIssues(config().github, async () => { calls++; await pending; return page([]); }, () => now);
  const first = service.get(), second = service.get();
  assert.equal(first, second); release();
  await first; await service.get(); assert.equal(calls, 1);
  now += 60000; await service.get(); assert.equal(calls, 2);
});

test('retains a complete snapshot after failure and respects server rate cooldown', async () => {
  let now = 1000, fail = false, calls = 0;
  const service = new GitHubIssues(config({ labels: ['one'] }).github, async endpoint => {
    calls++;
    if (fail) throw new GitHubError('Rate limited', 300000, true);
    return page(endpoint.startsWith('user/') ? [repo('private')] : [issue(1)]);
  }, () => now);
  const success = await service.get(); fail = true; now = 61000;
  const stale = await service.get();
  assert.deepEqual(stale.issues, success.issues); assert.equal(stale.updatedAt, success.updatedAt);
  assert.equal(stale.lastSuccessAt, success.lastSuccessAt); assert.equal(stale.stale, true);
  assert.equal(stale.error, 'Rate limited'); assert.equal(stale.nextRefreshAt, new Date(300000).toISOString());
  const previous = calls; now = 250000; await service.get(); assert.equal(calls, previous);
  fail = false; now = 300000; assert.equal((await service.get()).stale, false);
});

test('initial partial results are flagged, failures are not empty successes, and empty labels make no requests', async () => {
  const service = new GitHubIssues(config({ labels: ['one'] }).github, async endpoint => {
    if (endpoint.startsWith('user/')) return page([repo('first'), repo('second')]);
    if (endpoint.includes('/first/')) return page([issue(1)]);
    throw new GitHubError('Repository unavailable');
  });
  const partial = await service.get(); assert.equal(partial.partial, true); assert.equal(partial.stale, true);
  assert.equal(partial.issues.length, 1); assert.equal(partial.lastSuccessAt, null);
  const failed = await new GitHubIssues(config().github, async () => { throw new GitHubError('Authenticate'); }).get();
  assert.equal(failed.updatedAt, null); assert.equal(failed.error, 'Authenticate');
  const disabled = await new GitHubIssues(config({ labels: [] }).github, async () => { throw new Error('must not call'); }).get();
  assert.equal(disabled.error, null); assert.deepEqual(disabled.issues, []);
});

test('pagination caps and malformed responses explicitly mark incomplete results', async () => {
  let calls = 0;
  const service = new GitHubIssues(config().github, async () => { calls++; return page([], true); });
  assert.match((await service.get()).error!, /pagination limit/); assert.equal(calls, 100);
  const malformed = new GitHubIssues(config().github, async () => page({ unexpected: true }));
  assert.match((await malformed.get()).error!, /unexpected data/);
});

test('GitHub API uses existing host/origin protection and distinguishes unavailable from cached results', async () => {
  const monitor = new Monitor(config());
  const github = new GitHubIssues(monitor.config.github, async () => { throw new GitHubError('Authenticate'); });
  const server = createServer(monitor, 'dist/public', undefined, undefined, undefined, github);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/github`;
  try {
    const response = await fetch(url); assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json(); assert.equal(data.error, 'Authenticate'); assert.deepEqual(data.issues, []);
    assert.equal((await fetch(url, { headers: { Origin: 'http://evil.example' } })).status, 403);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      http.get(url, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
