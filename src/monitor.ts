import { resolveScript, type Config, type Resource } from './config.js';
import { run, type Runner, type CommandResult } from './process.js';

export type Action = 'start' | 'stop' | 'restart';
export class RequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export type ActionResult = {
  action: Action; state: 'running' | 'succeeded' | 'failed'; startedAt: string;
  finishedAt?: string; output: string; error?: string; truncated: boolean;
};
export type Snapshot = {
  id: string; name: string; containerName: string | null; uiUrl: string | null; lifecycle: string;
  liveness: 'healthy' | 'unhealthy' | 'unknown';
  readiness: 'healthy' | 'unhealthy' | 'unknown'; detail: string;
  checkedAt: string | null; configurationErrors: string[];
  availableActions: Action[]; lastAction?: ActionResult;
};

export class Monitor {
  snapshots: Snapshot[];
  podmanError: string | null = null;
  private refreshing?: Promise<void>;
  private active = new Set<string>();
  private lastActions = new Map<string, ActionResult>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(public config: Config, private runner: Runner = run) {
    this.snapshots = config.resources.map(r => ({ id: r.id, name: r.name, containerName: r.containerName, uiUrl: r.uiUrl,
      lifecycle: r.containerName ? 'unknown' : 'unconfigured', liveness: 'unknown', readiness: 'unknown', detail: 'Waiting for first check',
      checkedAt: null, configurationErrors: [], availableActions: [] }));
  }
  resource(id: string): Resource {
    const resource = this.config.resources.find(r => r.id === id);
    if (!resource) throw new RequestError('Unknown resource', 404);
    return resource;
  }
  data() {
    return { podmanError: this.podmanError, pollIntervalMs: this.config.pollIntervalMs,
      resources: this.snapshots.map(s => ({ ...s, availableActions: this.active.has(s.id) ? [] : s.availableActions,
        lastAction: this.lastActions.get(s.id) })) };
  }
  async start() {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.config.pollIntervalMs);
  }
  close() { clearInterval(this.timer); }
  refresh(): Promise<void> {
    if (!this.refreshing) this.refreshing = this.check().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refreshFresh() {
    if (this.refreshing) await this.refreshing;
    await this.refresh();
  }
  private async check() {
    let inventory: Array<{ Names: string[] | string; State: string }> = [];
    this.podmanError = null;
    try {
      const result = await this.runner('podman', ['ps', '--all', '--format', 'json'], 10000);
      if (result.code !== 0 || result.timedOut || result.truncated) throw new Error(result.output || 'Podman inventory failed or timed out');
      const parsed: unknown = JSON.parse(result.output);
      if (!Array.isArray(parsed) || !parsed.every(item => item && typeof item.State === 'string' &&
        (typeof item.Names === 'string' || (Array.isArray(item.Names) && item.Names.every((n: unknown) => typeof n === 'string'))))) {
        throw new Error('Unexpected Podman inventory format');
      }
      inventory = parsed;
    } catch (error) { this.podmanError = message(error); }
    this.snapshots = await Promise.all(this.config.resources.map(async r => {
      const errors: string[] = [];
      let creationAvailable = false;
      if (r.startScript) {
        try { await resolveScript(this.config.scriptsDirectory, r.startScript); creationAvailable = true; }
        catch (error) { errors.push(`Creation script: ${message(error)}`); }
      }
      if (!r.containerName) errors.unshift('Container name not configured');
      const container = inventory.find(c => (Array.isArray(c.Names) ? c.Names : [c.Names]).includes(r.containerName ?? ''));
      let lifecycle = !r.containerName ? 'unconfigured' : this.podmanError ? 'unknown' : !container ? 'missing' : container.State.toLowerCase();
      if (['exited', 'created', 'configured', 'stopped'].includes(lifecycle)) lifecycle = 'stopped';
      if (lifecycle === 'missing' && !r.startScript) errors.push('Creation script (startScript) not configured');
      let liveness: Snapshot['liveness'] = 'unknown';
      let readiness: Snapshot['readiness'] = 'unknown';
      let detail = !r.containerName ? 'Supply the exact Podman container name' : this.podmanError ??
        (lifecycle === 'missing' ? 'Container does not exist; a configured start script can create it' : 'No readiness check configured');
      const probeDetails: string[] = [];
      for (const kind of ['liveness', 'readiness'] as const) {
        const probe = r[kind];
        if (!probe) continue;
        const label = kind === 'liveness' ? 'Liveness' : 'Readiness';
        if (lifecycle !== 'running') {
          probeDetails.push(`${label} not checked: container is not running`);
          continue;
        }
        let status: Snapshot['readiness'];
        try {
          const response = await fetch(probe.url, { signal: AbortSignal.timeout(probe.timeoutMs), redirect: 'error' });
          status = response.ok ? 'healthy' : 'unhealthy';
          probeDetails.push(`${label} HTTP ${response.status}`);
          await response.body?.cancel();
        } catch (error) { status = 'unhealthy'; probeDetails.push(`${label}: ${message(error)}`); }
        if (kind === 'liveness') liveness = status;
        else readiness = status;
      }
      if (probeDetails.length) detail = this.podmanError ?? probeDetails.join('; ');
      const availableActions: Action[] = [];
      if (r.containerName && !this.podmanError) {
        if (lifecycle === 'stopped' || (lifecycle === 'missing' && creationAvailable)) availableActions.push('start');
        if (lifecycle === 'running') availableActions.push('stop');
        if (['running', 'stopped'].includes(lifecycle)) availableActions.push('restart');
      }
      return { id: r.id, name: r.name, containerName: r.containerName, uiUrl: r.uiUrl, lifecycle, liveness, readiness, detail,
        checkedAt: new Date().toISOString(), configurationErrors: errors, availableActions };
    }));
  }
  async act(id: string, action: Action, confirmed: boolean): Promise<ActionResult> {
    const resource = this.resource(id);
    if (action !== 'start' && !confirmed) throw new RequestError('Explicit confirmation required');
    if (this.active.has(id)) throw new RequestError('An action is already running for this resource', 409);
    this.active.add(id);
    let result: ActionResult | undefined;
    try {
      await this.refreshFresh();
      const snapshot = this.snapshots.find(s => s.id === id)!;
      if (!snapshot.availableActions.includes(action)) throw new RequestError('Action unavailable: check configuration and container state', 409);
      result = { action, state: 'running', startedAt: new Date().toISOString(), output: '', truncated: false };
      this.lastActions.set(id, result);
      const deadline = Date.now() + this.config.actionTimeoutMs;
      const append = (text: string) => {
        const output = result!.output + text;
        result!.truncated ||= output.length > 65536;
        result!.output = output.slice(-65536);
      };
      const execute = async (label: string, command: string, args: string[], cwd?: string): Promise<CommandResult> => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Action timed out');
        const execution = await this.runner(command, args, remaining, cwd);
        append(`\n--- ${label} ---\n${execution.output}`);
        result!.truncated ||= execution.truncated;
        if (execution.timedOut) throw new Error(`${label} timed out; inspect container state before retrying`);
        return execution;
      };
      const podman = async (step: 'start' | 'stop') => {
        const label = `podman ${step} ${resource.containerName!}`;
        const execution = await execute(label, 'podman', [step, resource.containerName!]);
        if (execution.code !== 0) throw new Error(`${label} exited with code ${execution.code}`);
      };
      if (action === 'start' && snapshot.lifecycle === 'missing') {
        const executable = await resolveScript(this.config.scriptsDirectory, resource.startScript!);
        const creation = await execute('create container (startScript)', executable, [], this.config.scriptsDirectory);
        if (creation.code !== 0) {
          append(`\nCreation exited with code ${creation.code}; trying Podman start for the configured container name.\n`);
          await podman('start');
        } else {
          await this.refreshFresh();
          const created = this.snapshots.find(s => s.id === id)!;
          if (created.lifecycle === 'stopped') await podman('start');
          else if (created.lifecycle !== 'running') throw new Error(`Creation script completed, but container state is ${created.lifecycle}`);
        }
      } else {
        if (action === 'stop' || action === 'restart') await podman('stop');
        if (action === 'start' || action === 'restart') await podman('start');
      }
      result.state = 'succeeded';
    } catch (error) {
      if (!result) throw error;
      result.state = 'failed'; result.error = message(error);
    } finally {
      if (result) { result.finishedAt = new Date().toISOString(); await this.refreshFresh(); }
      this.active.delete(id);
    }
    return result!;
  }
}
export function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
