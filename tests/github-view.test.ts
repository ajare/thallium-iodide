import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Minimal DOM port for view behavior, not an HTML parser: using innerHTML fails tests.
class Element {
  children: Element[] = [];
  textContent = ''; value = ''; disabled = false; open = false;
  href = ''; target = ''; rel = ''; className = '';
  onclick?: () => void; onchange?: () => void; oninput?: () => void;
  constructor(public tag: string) {}
  set innerHTML(_value: string) { throw new Error('HTML rendering is forbidden'); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  get text(): string { return [this.textContent, ...this.children.map(child => child.text)].join(' '); }
}
const issue = { repository: 'ajare/private-fork', number: 12, title: '<img src=x onerror=alert(1)>', body: 'A full description\n<script>unsafe()</script>', labels: ['one'], assignees: ['worker'], updatedAt: '2026-01-01T00:00:00Z', url: 'javascript:alert(1)' };
const snapshot = { owner: 'ajare', labels: ['one'], issues: [issue], updatedAt: '2026-01-01T00:00:00Z', lastSuccessAt: '2026-01-01T00:00:00Z', stale: false, partial: false, error: null, nextRefreshAt: new Date(Date.now() + 60000).toISOString() };
async function harness() {
  const ids = ['github-repository', 'github-search', 'github-refresh', 'github-status', 'github-issues', 'github-scope', 'github-count', 'github-tab'];
  const elements = new Map(ids.map(id => [id, new Element(id)]));
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0, calls = 0, fail = false;
  let data: unknown = snapshot;
  let visibility!: () => void;
  const document = { hidden: false, getElementById: (id: string) => elements.get(id), createElement: (tag: string) => new Element(tag), addEventListener: (_name: string, listener: () => void) => { visibility = listener; } };
  const source = await readFile(new URL('../web/github.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source.replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ document, AbortSignal,
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async () => { calls++; if (fail) throw new Error('offline'); return { status: 200, json: async () => data }; }
  });
  vm.runInContext(js, context);
  const view = vm.runInContext('createGitHubView()', context);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const el = (id: string) => elements.get(`github-${id}`)!;
  return { view, el, document, timers, settle, visibility: () => visibility(), calls: () => calls, fail: () => { fail = true; }, respond: (value: unknown) => { data = value; } };
}

test('GitHub view loads only while visible, refreshes on demand, schedules polling and stops on exit', async () => {
  const h = await harness();
  assert.equal(h.calls(), 0); h.view.refresh(); assert.equal(h.calls(), 0);
  h.view.setActive(true); await h.settle(); assert.equal(h.calls(), 1);
  assert.equal(h.timers.size, 1); assert.ok([...h.timers.values()][0].delay >= 60000);
  h.el('refresh').onclick!(); await h.settle(); assert.equal(h.calls(), 2);
  h.document.hidden = true; h.visibility(); assert.equal(h.timers.size, 0);
  h.view.refresh(); assert.equal(h.calls(), 2);
  h.document.hidden = false; h.visibility(); await h.settle(); assert.equal(h.calls(), 3);
  h.view.setActive(false); assert.equal(h.timers.size, 0);
  h.view.refresh(); assert.equal(h.calls(), 3);
  h.view.close();
});

test('GitHub view renders descriptions as text, supplies safe links and filters locally', async () => {
  const h = await harness(); h.view.setActive(true); await h.settle();
  assert.match(h.el('issues').text, /<script>unsafe\(\)<\/script>/);
  assert.match(h.el('issues').text, /Assignees: worker/);
  const card = h.el('issues').children[0];
  const link = card.children[0].children[0];
  assert.equal(link.href, 'https://github.com/ajare/private-fork/issues/12');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(card.children[4].tag, 'details');
  h.el('search').value = 'not matching'; h.el('search').oninput!();
  assert.match(h.el('issues').text, /No issues match these filters/);
  h.el('search').value = 'worker'; h.el('search').oninput!();
  assert.match(h.el('count').text, /1 of 1 issues/); assert.equal(h.calls(), 1);
  h.fail(); h.view.refresh(); await h.settle();
  assert.match(h.el('status').text, /stale results/);
  assert.match(h.el('issues').text, /private-fork/);
  h.view.close();
});

test('GitHub view distinguishes partial data, authentication failure, disabled labels and successful emptiness', async () => {
  const h = await harness();
  h.respond({ ...snapshot, partial: true, stale: true, error: 'Rate limit reached' });
  h.view.setActive(true); await h.settle();
  assert.match(h.el('status').text, /partial results/); assert.match(h.el('status').text, /Rate limit reached/);
  h.respond({ ...snapshot, issues: [], updatedAt: null, stale: true, error: 'Authenticate' });
  h.view.refresh(); await h.settle(); assert.match(h.el('issues').text, /could not be loaded/);
  assert.doesNotMatch(h.el('issues').text, /No matching/);
  h.respond({ ...snapshot, labels: [], issues: [] });
  h.view.refresh(); await h.settle(); assert.match(h.el('issues').text, /No labels configured/);
  h.respond({ ...snapshot, issues: [] });
  h.view.refresh(); await h.settle(); assert.match(h.el('issues').text, /No matching open issues/);
  h.view.close();
});
