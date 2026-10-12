import { TailOutput } from './tail-output.js';
import { parseTimeline } from './timeline.js';

type Action = 'start' | 'stop' | 'restart';
type Resource = {
  id: string; name: string; containerName: string | null; uiUrl: string | null; lifecycle: string; liveness: string; readiness: string;
  detail: string; checkedAt: string | null; configurationErrors: string[]; availableActions: Action[];
  lastAction?: { action: string; state: string; output: string; error?: string; truncated: boolean };
};
type State = { token: string; podmanError: string | null; resources: Resource[]; pollIntervalMs: number };
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type MonitoredFile = { id: string; path: string; modifiedAt: string };
let monitoredFiles: MonitoredFile[] = [];
let state: State | undefined;
let polling = false;
let timer: ReturnType<typeof setTimeout>;
const pending = new Set<string>();
const rows = new Map<string, HTMLTableRowElement>();
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el;
}
function banner(text: string | null) { element('banner').textContent = text; element('banner').hidden = !text; }
async function refresh() {
  if (polling) return;
  clearTimeout(timer); polling = true;
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
    state = await response.json() as State;
    element('connection').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    banner(state.podmanError ? `Podman unavailable: ${state.podmanError}` : null);
    render();
    await Promise.all([refreshFiles(), refreshBuildProcesses()]);
  } catch (error) { element('connection').textContent = 'Disconnected'; banner(String(error)); }
  finally { polling = false; timer = setTimeout(refresh, state?.pollIntervalMs ?? 5000); }
}
function render() {
  if (!state) return;
  syncLogTabs();
  element('containers-tab').textContent = `Containers (${state.resources.length})`;
  element('total').textContent = String(state.resources.length);
  element('running').textContent = String(state.resources.filter(r => r.lifecycle === 'running').length);
  element('healthy').textContent = String(state.resources.filter(r => r.readiness === 'healthy').length);
  element('attention').textContent = String(state.resources.filter(r => r.lifecycle !== 'running' || r.liveness === 'unhealthy' || r.readiness === 'unhealthy' || r.configurationErrors.length > 0).length);
  for (const resource of state.resources) {
    let row = rows.get(resource.id);
    if (!row) { row = node('tr'); rows.set(resource.id, row); element('resources').append(row); }
    // Preserve keyboard focus and output-panel state across polling updates.
    const focused = row.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.control : undefined;
    const expanded = row.querySelector('details')?.open ?? false;
    const name = node('th', undefined, 'container-info'); name.scope = 'row';
    name.append(node('div', resource.containerName ?? 'Container name not configured', 'container-name'), node('div', resource.name, 'resource-name'));
    const status = node('td'); status.append(node('span', resource.lifecycle, `badge ${resource.lifecycle}`));
    const liveness = node('td'); liveness.append(node('span', resource.liveness, `badge ${resource.liveness}`));
    const readiness = node('td'); readiness.append(node('span', resource.readiness, `badge ${resource.readiness}`));
    const content: Node[] = [name, status, liveness, readiness];
    if (resource.configurationErrors.length) {
      const errors = node('div', undefined, 'config-errors');
      const list = node('ul'); for (const error of resource.configurationErrors) list.append(node('li', error));
      errors.append(node('strong', 'Configuration required'), list); name.append(errors);
    }
    for (const action of ['start', 'stop', 'restart'] as const) {
      const button = node('button', action[0].toUpperCase() + action.slice(1), action);
      button.dataset.control = action;
      button.disabled = pending.has(resource.id) || !resource.availableActions.includes(action);
      button.title = button.disabled ? 'Unavailable in the current state, or missing a creation script for an absent container' : `${action} ${resource.name}`;
      button.setAttribute('aria-label', `${action} ${resource.name}`);
      button.onclick = () => void act(resource, action);
      const cell = node('td'); cell.append(button); content.push(cell);
    }
    const logs = node('button', 'View logs'); logs.dataset.control = 'logs';
    logs.disabled = ['missing', 'unknown', 'unconfigured'].includes(resource.lifecycle);
    logs.setAttribute('aria-label', `View logs for ${resource.name}`);
    logs.onclick = () => openLogs(resource);
    const logCell = node('td'); logCell.append(logs); content.push(logCell);
    const terminal = node('button', 'Terminal'); terminal.dataset.control = 'terminal';
    terminal.disabled = resource.lifecycle !== 'running';
    terminal.title = terminal.disabled ? 'Requires a running container' : `Open a terminal inside ${resource.name}`;
    terminal.setAttribute('aria-label', `Open a terminal inside ${resource.name}`);
    terminal.onclick = () => void openTerminal(resource);
    const terminalCell = node('td'); terminalCell.append(terminal); content.push(terminalCell);
    if (resource.lastAction) {
      const action = resource.lastAction;
      const details = node('details'); details.open = expanded;
      details.append(node('summary', `${action.action}: ${action.state}${action.truncated ? ' · output truncated' : ''}`, action.state === 'running' ? 'action-running' : ''));
      if (action.error) details.append(node('div', action.error, 'action-error'));
      details.append(node('pre', action.output || 'No command output.'));
      if (action.state === 'succeeded') details.append(node('p', 'Commands completed; check lifecycle and readiness above.'));
      name.append(details);
    }
    const uiCell = node('td');
    if (resource.uiUrl) {
      const link = node('a', 'UI', 'ui-link');
      link.href = resource.uiUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `Open UI for ${resource.name}`);
      uiCell.append(link);
    }
    content.push(uiCell);
    content.push(node('td', resource.checkedAt ? new Date(resource.checkedAt).toLocaleTimeString() : 'Not checked yet', 'checked-time'));
    row.replaceChildren(...content);
    if (focused) row.querySelector<HTMLButtonElement>(`[data-control="${focused}"]`)?.focus();
  }
  for (const [id, row] of rows) {
    if (!state.resources.some(resource => resource.id === id)) { row.remove(); rows.delete(id); }
  }
}
async function act(resource: Resource, action: Action) {
  if (!state || pending.has(resource.id)) return;
  if (action !== 'start' && !window.confirm(`${action === 'restart' ? 'Restart' : 'Stop'} ${resource.name}? This may interrupt active AI requests.`)) return;
  pending.add(resource.id); render();
  try {
    const response = await fetch(`/api/resources/${resource.id}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Control-Token': state.token },
      body: JSON.stringify({ action, confirmed: action !== 'start' })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Action failed');
  } catch (error) { window.alert(String(error)); }
  finally { pending.delete(resource.id); await refresh(); render(); }
}
let stream: EventSource | undefined;
let activeLogs: string | null = null;
type LogView = { tab: HTMLButtonElement; panel: HTMLElement; title: HTMLElement; output: HTMLElement; status: HTMLElement; autoscroll: HTMLInputElement; buffer: TailOutput; fileId?: string; mode?: 'raw' | 'timeline'; timelineEl?: HTMLElement; timelineSelected?: string };
const logViews = new Map<string, LogView>();
function stopStream() { stream?.close(); stream = undefined; }
function syncLogTabs() {
  if (!state) return;
  for (const resource of state.resources) {
    let view = logViews.get(resource.id);
    if (!view) {
      const tab = node('button'); tab.id = `logs-tab-${resource.id}`; tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', 'false'); tab.tabIndex = -1;
      const panel = node('section', undefined, 'logs-panel'); panel.id = `logs-panel-${resource.id}`;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0; panel.hidden = true;
      tab.setAttribute('aria-controls', panel.id); tab.onclick = () => selectTab(resource.id);
      const title = node('h2');
      const tools = node('div', undefined, 'log-tools');
      const autoscroll = node('input'); autoscroll.type = 'checkbox'; autoscroll.checked = true;
      const label = node('label'); label.append(autoscroll, ' Auto-scroll');
      const clear = node('button', 'Clear view'); const reconnect = node('button', 'Reconnect');
      const status = node('span', 'Select this tab to stream logs'); status.setAttribute('role', 'status');
      const output = node('pre', '', 'log-output'); output.tabIndex = 0;
      const buffer = new TailOutput();
      clear.onclick = () => { buffer.clear(); output.textContent = ''; };
      reconnect.onclick = () => startLogs(resource.id);
      tools.append(label, clear, reconnect, status);
      panel.append(node('p', 'CONTAINER LOGS · LAST 200 LINES + LIVE', 'eyebrow'), title, tools, output);
      element('tabs').append(tab); element('tab-panels').append(panel);
      view = { tab, panel, title, output, status, autoscroll, buffer }; logViews.set(resource.id, view);
    }
    view.tab.textContent = `${resource.containerName ?? resource.name} logs`;
    view.title.textContent = resource.containerName ?? resource.name;
  }
  for (const [id, view] of logViews) {
    if (!view.fileId && !state.resources.some(resource => resource.id === id)) {
      if (activeLogs === id) selectTab(null);
      view.tab.remove(); view.panel.remove(); logViews.delete(id);
    }
  }
}
function selectTab(id: string | null) {
  stopStream();
  if (activeLogs && logViews.has(activeLogs)) logViews.get(activeLogs)!.status.textContent = 'Paused — select this tab to reconnect';
  activeLogs = id;
  element('build-processes-panel').hidden = id !== ':build-processes';
  element('build-processes-tab').setAttribute('aria-selected', String(id === ':build-processes'));
  element('build-processes-tab').tabIndex = id === ':build-processes' ? 0 : -1;
  element('files-panel').hidden = id !== ':files';
  element('files-tab').setAttribute('aria-selected', String(id === ':files'));
  element('files-tab').tabIndex = id === ':files' ? 0 : -1;
  element('containers-panel').hidden = id !== null;
  element('containers-tab').setAttribute('aria-selected', String(id === null));
  element('containers-tab').tabIndex = id === null ? 0 : -1;
  for (const [key, view] of logViews) {
    view.panel.hidden = key !== id; view.tab.setAttribute('aria-selected', String(key === id));
    view.tab.tabIndex = key === id ? 0 : -1;
  }
  if (id && logViews.has(id)) startLogs(id);
}
function startLogs(id: string) {
  if (activeLogs !== id) return;
  stopStream();
  const view = logViews.get(id)!;
  const resource = state?.resources.find(resource => resource.id === id);
  if (!view.fileId && (!resource || ['missing', 'unknown', 'unconfigured'].includes(resource.lifecycle))) {
    view.status.textContent = 'Logs unavailable in the current container state'; return;
  }
  view.status.textContent = 'Connecting…';
  // A reconnect includes the recent tail again; retain prior output until new data arrives.
  let first = true;
  const source = new EventSource(view.fileId ? `/api/files/${view.fileId}/logs` : `/api/resources/${id}/logs`); stream = source;
  source.onopen = () => { if (stream === source) view.status.textContent = 'Live'; };
  source.addEventListener('log', event => {
    if (stream !== source) return;
    if (first) { view.buffer.clear(); view.output.textContent = ''; first = false; }
    const text = JSON.parse((event as MessageEvent).data) as string;
    view.output.textContent = view.buffer.append(text);
    if (view.autoscroll.checked) view.output.scrollTop = view.output.scrollHeight;
    // The timeline re-parses the raw buffer on every chunk, staying in lockstep with the tail.
    if (view.mode === 'timeline' && view.timelineEl) {
      renderTimeline(view);
      if (view.autoscroll.checked) scrollTimelineToLiveEdge(view);
    }
  });
  source.addEventListener('ended', event => {
    if (stream !== source) return;
    view.status.textContent = JSON.parse((event as MessageEvent).data); stopStream();
  });
  source.onerror = () => {
    if (stream !== source) return;
    view.status.textContent = 'Disconnected or unavailable — reconnect to retry'; stopStream();
  };
}
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}
function scrollTimelineToLiveEdge(view: LogView) {
  const scroll = view.timelineEl?.querySelector('.timeline-scroll');
  if (scroll) scroll.scrollLeft = scroll.scrollWidth;
}
function renderTimelineDetail(view: LogView, panel: HTMLElement) {
  const event = parseTimeline(view.buffer.rawText()).find(event => event.id === view.timelineSelected);
  panel.replaceChildren();
  if (!event) { panel.append(node('p', 'Select an event on the graph to inspect it.', 'timeline-hint')); return; }
  const head = node('div', undefined, 'timeline-head');
  const time = node('time', event.at != null ? new Date(event.at).toLocaleString() : '—');
  if (event.at != null) time.dateTime = new Date(event.at).toISOString();
  head.append(node('span', event.kind === 'inference' ? 'INFERENCE' : 'TOOL', `badge ${event.kind}`), node('strong', event.title), time);
  for (const chip of event.meta) head.append(node('span', chip, 'timeline-meta'));
  panel.append(head, node('p', event.summary, 'timeline-summary'), node('pre', event.detail));
}
function selectTimelineEvent(view: LogView, id: string) {
  view.timelineSelected = id;
  const container = view.timelineEl!;
  for (const el of container.querySelectorAll('.selected')) el.classList.remove('selected');
  container.querySelector(`[data-event-id="${CSS.escape(id)}"]`)?.classList.add('selected');
  const panel = container.querySelector('.timeline-detail');
  if (panel) renderTimelineDetail(view, panel as HTMLElement);
}
// Events are plotted left-to-right with time on the X axis: inference turns and tool calls on separate lanes.
function renderTimeline(view: LogView) {
  const container = view.timelineEl!;
  const events = parseTimeline(view.buffer.rawText()).filter(event => event.at != null);
  container.replaceChildren();
  if (!events.length) { container.append(node('p', 'No events parsed yet.', 'timeline-empty')); return; }
  const t0 = Math.min(...events.map(event => event.at!));
  const t1 = Math.max(...events.map(event => event.endAt ?? event.at!));
  const span = Math.max(t1 - t0, 1000);
  const labelWidth = 76, padRight = 24, inferenceY = 52, toolY = 118, axisY = 162, height = 186;
  const width = Math.max(900, events.length * 14 + labelWidth + padRight + 20);
  const x = (at: number) => labelWidth + ((at - t0) / span) * (width - labelWidth - padRight);
  const svg = svgNode('svg', { width: String(width), height: String(height), class: 'timeline-graph', role: 'list', 'aria-label': 'Event timeline' });
  for (const [label, y] of [['INFERENCE', inferenceY], ['TOOL CALLS', toolY]] as const) {
    const laneLabel = svgNode('text', { x: '8', y: String(y + 4), class: 'lane-label' });
    laneLabel.textContent = label;
    svg.append(laneLabel, svgNode('line', { x1: String(labelWidth), x2: String(width - padRight), y1: String(y), y2: String(y), class: 'lane' }));
  }
  const ticks = 6;
  const dateTicks = span >= 12 * 3600 * 1000;
  for (let i = 0; i <= ticks; i++) {
    const at = t0 + (span * i) / ticks;
    const tx = x(at);
    svg.append(svgNode('line', { x1: String(tx), x2: String(tx), y1: '24', y2: String(axisY), class: 'grid' }));
    const tick = svgNode('text', { x: String(tx), y: String(axisY + 16), class: 'tick', 'text-anchor': 'middle' });
    tick.textContent = new Date(at)[dateTicks ? 'toLocaleString' : 'toLocaleTimeString']();
    svg.append(tick);
  }
  svg.append(svgNode('line', { x1: String(labelWidth), x2: String(width - padRight), y1: String(axisY), y2: String(axisY), class: 'axis' }));
  for (const event of events) {
    const y = event.kind === 'inference' ? inferenceY : toolY;
    const cls = `${event.kind}${event.error ? ' error' : ''}${event.id === view.timelineSelected ? ' selected' : ''}`;
    const shape = event.kind === 'tool' && event.endAt != null && event.endAt > event.at!
      ? svgNode('rect', { x: String(x(event.at!)), y: String(y - 5), width: String(Math.max(x(event.endAt) - x(event.at!), 3)), height: '10', rx: '3', class: `bar ${cls}` })
      : svgNode('circle', { cx: String(x(event.at!)), cy: String(y), r: '5', class: `marker ${cls}` });
    shape.dataset.eventId = event.id;
    shape.setAttribute('tabindex', '0');
    shape.setAttribute('role', 'listitem');
    const when = new Date(event.at!).toLocaleTimeString();
    shape.setAttribute('aria-label', `${event.kind === 'inference' ? 'Inference' : 'Tool call'} ${event.title} at ${when}: ${event.summary}`);
    const tooltip = svgNode('title'); tooltip.textContent = `${when} · ${event.title} · ${event.summary}`; shape.append(tooltip);
    shape.addEventListener('click', () => selectTimelineEvent(view, event.id));
    shape.addEventListener('keydown', keyEvent => {
      const key = keyEvent as KeyboardEvent;
      if (key.key === 'Enter' || key.key === ' ') { key.preventDefault(); selectTimelineEvent(view, event.id); }
    });
    svg.append(shape);
  }
  const legend = node('p', undefined, 'timeline-legend');
  legend.append(node('span', '●', 'legend-inference'), ' Inference turn  ', node('span', '▬', 'legend-tool'), ' Tool call (bar = call duration, red = error)');
  const scroll = node('div', undefined, 'timeline-scroll');
  scroll.append(svg);
  const detail = node('div', undefined, 'timeline-detail');
  renderTimelineDetail(view, detail);
  container.append(legend, scroll, detail);
}
function openLogs(resource: Resource) {
  selectTab(resource.id); logViews.get(resource.id)?.tab.focus();
}
async function openTerminal(resource: Resource) {
  if (!state) return;
  try {
    const response = await fetch(`/api/resources/${resource.id}/terminal`, { method: 'POST', headers: { 'X-Control-Token': state.token } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Terminal failed to open');
  } catch (error) { window.alert(String(error)); }
}
async function refreshFiles() {
  try {
    const response = await fetch('/api/files');
    if (!response.ok) throw new Error(`File scan returned HTTP ${response.status}`);
    const data = await response.json() as { files: MonitoredFile[]; errors: string[] };
    monitoredFiles = data.files;
    element('file-errors').textContent = data.errors.join('\n');
    renderFiles();
  } catch (error) { element('file-errors').textContent = String(error); }
}
function renderFiles() {
  element('files-tab').textContent = `Files (${monitoredFiles.length})`;
  const body = element('files');
  const focused = body.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.fileId : undefined;
  body.replaceChildren();
  for (const file of monitoredFiles) {
    const row = node('tr'); const name = node('th', file.path); name.scope = 'row';
    const date = node('td'); const time = node('time', new Date(file.modifiedAt).toLocaleString());
    time.dateTime = file.modifiedAt; date.append(time);
    const cell = node('td'); const label = node('label'); const checkbox = node('input');
    checkbox.type = 'checkbox'; checkbox.checked = logViews.has(`file:${file.id}`); checkbox.dataset.fileId = file.id;
    checkbox.setAttribute('aria-label', `Tail ${file.path}`);
    checkbox.onchange = () => {
      const key = `file:${file.id}`;
      if (checkbox.checked) { openFile(file); }
      else {
        const view = logViews.get(key);
        if (activeLogs === key) selectTab(':files');
        view?.tab.remove(); view?.panel.remove(); logViews.delete(key);
      }
    };
    label.append(checkbox, ' Tail'); cell.append(label); row.append(name, date, cell); body.append(row);
    if (focused === file.id) checkbox.focus();
  }
  if (!monitoredFiles.length) {
    const row = node('tr'); const cell = node('td', 'No matching files. Configure monitoredPaths in config.json.');
    cell.colSpan = 3; row.append(cell); body.append(row);
  }
}
function openFile(file: MonitoredFile) {
  const key = `file:${file.id}`;
  if (!logViews.has(key)) {
    const tab = node('button', `${file.path.split('/').pop()} tail`); tab.title = file.path;
    tab.id = `logs-tab-${key}`; tab.setAttribute('role', 'tab'); tab.onclick = () => selectTab(key);
    const panel = node('section', undefined, 'logs-panel'); panel.id = `logs-panel-${key}`;
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
    tab.setAttribute('aria-controls', panel.id);
    const title = node('h2', file.path); const tools = node('div', undefined, 'log-tools');
    const autoscroll = node('input'); autoscroll.type = 'checkbox'; autoscroll.checked = true;
    const label = node('label'); label.append(autoscroll, ' Auto-scroll');
    const clear = node('button', 'Clear view'); const reconnect = node('button', 'Reconnect'); const close = node('button', 'Stop tail');
    const status = node('span'); status.setAttribute('role', 'status'); const output = node('pre', '', 'log-output'); output.tabIndex = 0;
    const buffer = new TailOutput(file.path);
    const view: LogView = { tab, panel, title, output, status, autoscroll, buffer, fileId: file.id };
    panel.append(node('p', 'FILE TAIL · LAST 200 LINES + LIVE', 'eyebrow'), title, tools, output);
    // JSONL files get a parsed event timeline alongside the raw tail.
    if (file.path.toLowerCase().endsWith('.jsonl')) {
      view.mode = 'raw';
      const timelineEl = node('div', undefined, 'timeline'); timelineEl.hidden = true;
      view.timelineEl = timelineEl; panel.append(timelineEl);
      const rawButton = node('button', 'Raw'); rawButton.setAttribute('aria-pressed', 'true');
      const timelineButton = node('button', 'Timeline'); timelineButton.setAttribute('aria-pressed', 'false');
      const setMode = (mode: 'raw' | 'timeline') => {
        view.mode = mode;
        rawButton.setAttribute('aria-pressed', String(mode === 'raw'));
        timelineButton.setAttribute('aria-pressed', String(mode === 'timeline'));
        output.hidden = mode !== 'raw'; timelineEl.hidden = mode !== 'timeline';
        if (mode === 'timeline') {
          renderTimeline(view);
          if (autoscroll.checked) scrollTimelineToLiveEdge(view);
        }
      };
      rawButton.onclick = () => setMode('raw'); timelineButton.onclick = () => setMode('timeline');
      const switcher = node('span', undefined, 'view-switch'); switcher.append(rawButton, timelineButton);
      tools.append(label, switcher, clear, reconnect, close, status);
    } else {
      tools.append(label, clear, reconnect, close, status);
    }
    clear.onclick = () => { buffer.clear(); output.textContent = ''; if (view.timelineEl) renderTimeline(view); };
    reconnect.onclick = () => startLogs(key);
    close.onclick = () => { selectTab(':files'); tab.remove(); panel.remove(); logViews.delete(key); renderFiles(); };
    element('tabs').append(tab); element('tab-panels').append(panel);
    logViews.set(key, view);
  }
  selectTab(key); logViews.get(key)!.tab.focus();
}
type BuildProcess = { pid: number; command: string; startedAt: string; elapsedSeconds: number; cpuPercent: number; memoryBytes: number; memoryPercent: number };
function elapsedTime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${days ? `${days}d ` : ''}${hours}h ${minutes}m ${seconds % 60}s`;
}
async function refreshBuildProcesses() {
  try {
    const response = await fetch('/api/build-processes');
    if (!response.ok) throw new Error(`Process scan returned HTTP ${response.status}`);
    const { processes, monitoredProcesses } = await response.json() as { processes: BuildProcess[]; monitoredProcesses: string[] };
    element('build-processes-tab').textContent = `Processes (${processes.length})`;
    const body = element('build-processes'); body.replaceChildren();
    for (const process of processes) {
      const row = node('tr');
      const command = node('th', process.command); command.scope = 'row';
      const started = node('td'); const time = node('time', new Date(process.startedAt).toLocaleString());
      time.dateTime = process.startedAt; started.append(time);
      row.append(node('td', String(process.pid)), command, started, node('td', elapsedTime(process.elapsedSeconds)),
        node('td', `${process.cpuPercent.toFixed(1)}%`), node('td', `${(process.memoryBytes / 1048576).toFixed(1)} MiB`), node('td', `${process.memoryPercent.toFixed(1)}%`));
      body.append(row);
    }
    if (!processes.length) {
      const row = node('tr'); const cell = node('td', monitoredProcesses.length ? 'No matching processes are running.' : 'No process names configured. Add monitoredProcesses in config.json.');
      cell.colSpan = 7; row.append(cell); body.append(row);
    }
    element('build-processes-status').textContent = `${processes.length} running · Monitoring: ${monitoredProcesses.join(', ') || 'none'} · Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    element('build-processes-tab').textContent = 'Processes';
    element('build-processes').replaceChildren();
    element('build-processes-status').textContent = `Process data unavailable: ${String(error)}`;
  }
}
element('build-processes-tab').onclick = () => selectTab(':build-processes');
element('files-tab').onclick = () => selectTab(':files');
element('containers-tab').onclick = () => selectTab(null);
element('tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(element('tabs').querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
    (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click(); tabs[next].focus();
});
element('refresh').onclick = () => void refresh();
window.addEventListener('pagehide', () => { stream?.close(); clearTimeout(timer); });
void refresh();
