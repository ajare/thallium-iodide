import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { scanFiles } from './files.js';
import { scanBuildProcesses } from './build-processes.js';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { Monitor, RequestError, message, type Action } from './monitor.js';
import { openContainerTerminal } from './terminal.js';

const spawnLogs = (containerName: string) => spawn('podman', ['logs', '--tail', '200', '--follow', '--timestamps', containerName], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

export function createServer(monitor: Monitor, publicDirectory: string, startLogProcess = spawnLogs, scanProcesses = () => scanBuildProcesses(monitor.config.monitoredProcesses), openTerminal: (containerName: string) => Promise<void> = openContainerTerminal) {
  const allowedHosts = new Set(['localhost', '0.0.0.0', '127.0.0.1', ...Object.values(networkInterfaces()).flatMap(addresses => (addresses ?? []).filter(address => address.family === 'IPv4').map(address => address.address))]);
  const token = randomBytes(32).toString('hex');
  const requireToken = (req: IncomingMessage) => {
    const supplied = req.headers['x-control-token'];
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      throw new RequestError('Invalid action token', 403);
    }
  };
  let streams = 0;
  const logProcesses = new Set<ReturnType<typeof spawn>>();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src http://localhost:3000 http://127.0.0.1:3000; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const port = (server.address() as { port: number } | null)?.port ?? monitor.config.port;
      const host = req.headers.host;
      if (![...allowedHosts].some(address => host === `${address}:${port}`)) throw new RequestError('Invalid Host header', 403);
      if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new RequestError('Cross-origin access forbidden', 403);
      }
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, 200, { ...monitor.data(), token }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/files') {
        json(res, 200, await scanFiles(monitor.config.monitoredPaths)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/build-processes') {
        json(res, 200, { processes: await scanProcesses(), monitoredProcesses: monitor.config.monitoredProcesses }); return;
      }
      const fileMatch = /^\/api\/files\/([a-f0-9]{64})\/logs$/.exec(url.pathname);
      const match = /^\/api\/resources\/([a-z0-9-]+)\/(actions|logs|terminal)$/.exec(url.pathname);
      if (match && match[2] === 'actions' && req.method === 'POST') {
        requireToken(req);
        if (req.headers['content-type'] !== 'application/json') throw new RequestError('Use application/json', 415);
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || !['start', 'stop', 'restart'].includes(body.action)) throw new RequestError('Invalid action');
        const result = await monitor.act(match[1], body.action as Action, body.confirmed === true);
        json(res, result.state === 'failed' ? 422 : 200, result); return;
      }
      if (match && match[2] === 'terminal' && req.method === 'POST') {
        requireToken(req);
        const resource = monitor.resource(match[1]);
        const snapshot = monitor.snapshots.find(s => s.id === resource.id)!;
        if (!resource.containerName || snapshot.lifecycle !== 'running') throw new RequestError('Terminal requires a running container', 409);
        try {
          await openTerminal(resource.containerName);
        } catch (error) {
          throw new RequestError(message(error), 503);
        }
        json(res, 200, { ok: true }); return;
      }
      if (((match && match[2] === 'logs') || fileMatch) && req.method === 'GET') {
        let startProcess: () => ReturnType<typeof spawn>;
        if (fileMatch) {
          const { files } = await scanFiles(monitor.config.monitoredPaths);
          const file = files.find(file => file.id === fileMatch[1]);
          if (!file) throw new RequestError('Monitored file not found', 404);
          startProcess = () => spawn('tail', ['-n', '200', '-F', '--', file.path], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        } else {
          const resource = monitor.resource(match![1]);
          const snapshot = monitor.snapshots.find(s => s.id === resource.id)!;
          if (!resource.containerName || ['missing', 'unknown', 'unconfigured'].includes(snapshot.lifecycle)) throw new RequestError('Container logs unavailable', 409);
          startProcess = () => startLogProcess(resource.containerName!);
        }
        if (streams >= 5) throw new RequestError('Too many log viewers; close an existing viewer', 429);
        streams++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        const child = startProcess();
        logProcesses.add(child);
        let closed = false;
        let blocked = false;
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        function write(frame: string) {
          if (closed) return;
          // false means this frame was accepted, but the socket needs time to drain.
          if (!res.write(frame) && !blocked) {
            blocked = true;
            child.stdout!.pause(); child.stderr!.pause();
            stallTimer = setTimeout(cleanup, 30000);
          }
        }
        function drained() {
          if (closed || !blocked) return;
          blocked = false; clearTimeout(stallTimer);
          child.stdout!.resume(); child.stderr!.resume();
        }
        res.on('drain', drained);
        const send = (event: string, text: string) => write(`event: ${event}\ndata: ${JSON.stringify(text)}\n\n`);
        const heartbeat = setInterval(() => { if (!blocked) write(': heartbeat\n\n'); }, 15000);
        function cleanup() {
          if (closed) return;
          closed = true; clearInterval(heartbeat); clearTimeout(stallTimer); res.off('drain', drained);
          streams--; logProcesses.delete(child);
          child.kill('SIGKILL'); res.end();
        }
        child.stdout!.setEncoding('utf8').on('data', (chunk: string) => send('log', chunk));
        child.stderr!.setEncoding('utf8').on('data', (chunk: string) => send('log', chunk));
        child.on('error', error => { send('ended', message(error)); cleanup(); });
        child.on('close', code => { send('ended', `Log stream ended (exit ${code})`); cleanup(); });
        res.on('close', cleanup);
        return;
      }
      if (req.method === 'GET') {
        const files: Record<string, [string, string]> = {
          '/': ['index.html', 'text/html; charset=utf-8'],
          '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
          '/tail-output.js': ['tail-output.js', 'text/javascript; charset=utf-8'],
          '/timeline.js': ['timeline.js', 'text/javascript; charset=utf-8'],
          '/style.css': ['style.css', 'text/css; charset=utf-8']
        };
        const file = files[url.pathname];
        if (file) { res.setHeader('Content-Type', file[1]); res.end(await readFile(path.join(publicDirectory, file[0]))); return; }
      }
      throw new RequestError('Not found', 404);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof RequestError ? error.status : 500, { error: message(error) });
      else res.end();
    }
  });
  server.requestTimeout = 650000;
  server.on('close', () => { for (const child of logProcesses) child.kill('SIGKILL'); });
  return server;
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body));
}
async function readJson(req: IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString();
    if (text.length > 4096) throw new RequestError('Request body too large', 413);
  }
  try { return JSON.parse(text); } catch { throw new RequestError('Invalid JSON'); }
}
