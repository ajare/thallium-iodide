import path from 'node:path';
import { loadConfig } from './config.js';
import { Monitor } from './monitor.js';
import { createServer } from './server.js';
import { terminateCommands } from './process.js';

try {
  const config = await loadConfig(path.resolve(process.env.CONFIG_PATH ?? 'config.json'));
  const monitor = new Monitor(config);
  await monitor.start();
  const server = createServer(monitor, path.resolve('dist/public'));
  server.on('error', error => { console.error(error.message); monitor.close(); process.exitCode = 1; });
  server.listen(config.port, '0.0.0.0', () => console.log(`Thallium Iodide: http://0.0.0.0:${config.port}`));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true; monitor.close(); terminateCommands();
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  });
} catch (error) {
  console.error(`Unable to start: ${error instanceof Error ? error.message : error}`);
  console.error('Copy config.example.json to config.json and edit it, then run npm start.');
  process.exitCode = 1;
}
