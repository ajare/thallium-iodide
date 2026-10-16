type Issue = { repository: string; number: number; title: string; body: string; url: string; labels: string[]; assignees: string[]; updatedAt: string };
type Snapshot = { owner: string; labels: string[]; issues: Issue[]; updatedAt: string | null; lastSuccessAt: string | null; stale: boolean; partial: boolean; error: string | null; nextRefreshAt: string };
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el;
}
export function createGitHubView() {
  let active = false, loading = false;
  let snapshot: Snapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expanded = new Set<string>();
  const repository = element<HTMLSelectElement>('github-repository');
  const search = element<HTMLInputElement>('github-search');
  const refresh = element<HTMLButtonElement>('github-refresh');
  const status = element('github-status');
  const list = element('github-issues');
  function render() {
    if (!snapshot) return;
    element('github-scope').textContent = `Open issues owned by ${snapshot.owner} · Any label: ${snapshot.labels.join(', ') || 'none configured'} · Private repositories and forks included; archived repositories excluded.`;
    const selected = repository.value;
    const names = [...new Set(snapshot.issues.map(issue => issue.repository))].sort();
    repository.replaceChildren();
    const all = node('option', 'All repositories'); all.value = ''; repository.append(all);
    for (const name of names) { const option = node('option', name); option.value = name; repository.append(option); }
    repository.value = names.includes(selected) ? selected : '';
    const query = search.value.trim().toLowerCase();
    const matches = snapshot.issues.filter(issue => (!repository.value || issue.repository === repository.value) &&
      `${issue.repository} #${issue.number} ${issue.title} ${issue.body} ${issue.labels.join(' ')} ${issue.assignees.join(' ')}`.toLowerCase().includes(query));
    list.replaceChildren();
    for (const issue of matches) {
      const key = `${issue.repository}#${issue.number}`;
      const card = node('article', undefined, 'github-issue');
      const title = node('h3'); const link = node('a', `${issue.repository} #${issue.number} · ${issue.title}`);
      // Defense in depth: never turn arbitrary upstream URLs into clickable links.
      link.href = `https://github.com/${encodeURIComponent(snapshot.owner)}/${encodeURIComponent(issue.repository.split('/')[1])}/issues/${issue.number}`;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; title.append(link);
      const meta = node('p', `Assignees: ${issue.assignees.join(', ') || 'Unassigned'} · Updated ${new Date(issue.updatedAt).toLocaleString()}`, 'github-meta');
      const labels = node('div', undefined, 'github-labels');
      for (const label of issue.labels) labels.append(node('span', label, 'badge'));
      const preview = node('p', issue.body ? issue.body.slice(0, 240) + (issue.body.length > 240 ? '…' : '') : 'No description.', 'github-preview');
      const details = node('details'); details.open = expanded.has(key);
      details.append(node('summary', 'Full description'), node('div', issue.body || 'No description.', 'github-body'));
      details.ontoggle = () => { if (details.open) expanded.add(key); else expanded.delete(key); };
      card.append(title, meta, labels, preview, details); list.append(card);
    }
    element('github-count').textContent = `${matches.length} of ${snapshot.issues.length} issues${snapshot.partial ? ' (partial results)' : ''}`;
    element('github-tab').textContent = `GitHub (${snapshot.issues.length})`;
    if (!matches.length) list.append(node('p', snapshot.error && !snapshot.updatedAt ? 'Issues could not be loaded.' : !snapshot.labels.length ? 'No labels configured. Add github.labels in config.json.' : snapshot.issues.length ? 'No issues match these filters.' : snapshot.partial || snapshot.error ? 'No issues available; the refresh was incomplete.' : 'No matching open issues.'));
    const updated = snapshot.updatedAt ? `Results from ${new Date(snapshot.updatedAt).toLocaleString()}.` : 'No successful results yet.';
    status.textContent = [snapshot.stale ? 'Stale / incomplete.' : 'Up to date.', updated, snapshot.partial ? 'Only partial results are available.' : '', snapshot.error ?? '', `Next GitHub check eligible at ${new Date(snapshot.nextRefreshAt).toLocaleTimeString()}.`].filter(Boolean).join(' ');
  }
  function schedule() {
    clearTimeout(timer);
    if (active && !document.hidden) timer = setTimeout(() => void load(), Math.max(60000, Date.parse(snapshot?.nextRefreshAt ?? '') - Date.now() || 0));
  }
  async function load() {
    if (loading || !active || document.hidden) return;
    clearTimeout(timer); loading = true; refresh.disabled = true;
    status.textContent = snapshot ? 'Refreshing GitHub… Showing previous results.' : 'Loading GitHub issues…';
    try {
      const response = await fetch('/api/github', { signal: AbortSignal.timeout(150000) });
      const data = await response.json();
      if (!Array.isArray(data.issues)) throw new Error(`HTTP ${response.status}`);
      snapshot = data as Snapshot; render();
    } catch {
      status.textContent = `GitHub unavailable. ${snapshot?.updatedAt ? `Showing stale results from ${new Date(snapshot.updatedAt).toLocaleString()}.` : 'No results loaded.'} Try Refresh again.`;
    } finally { loading = false; refresh.disabled = false; schedule(); }
  }
  repository.onchange = render; search.oninput = render;
  refresh.onclick = () => void load();
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (active && !document.hidden) void load(); });
  return {
    setActive(value: boolean) { const changed = active !== value; active = value; clearTimeout(timer); if (active && changed) void load(); },
    refresh: () => void load(),
    close() { active = false; clearTimeout(timer); }
  };
}
