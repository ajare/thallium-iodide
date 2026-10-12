import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuildProcesses, scanBuildProcesses } from '../src/build-processes.js';
import { createServer } from '../src/server.js';
import { Monitor } from '../src/monitor.js';
import { configSchema } from '../src/config.js';

const sample = `
  101 cmake Sat Oct 10 15:00:00 2026 65 2.5 0.1 2048 cmake --build /tmp/build
  102 g++ Sat Oct 10 15:00:01 2026 64 120.0 0.2 4096 /usr/bin/g++ -c main.cpp
  103 ctest Sat Oct 10 15:00:02 2026 63 0.0 0.0 512 ctest --output-on-failure
  104 gcc-14 Sat Oct 10 15:00:03 2026 62 4.0 0.1 1024 gcc-14 -c test.c
  105 x86_64-linux-gn Sat Oct 10 15:00:04 2026 61 5.0 0.1 1024 /usr/bin/x86_64-linux-gnu-g++-14 -c test.cpp
  106 bash Sat Oct 10 15:00:05 2026 60 0.0 0.0 512 bash -c cmake
  107 ctest-helper Sat Oct 10 15:00:05 2026 60 0.0 0.0 512 ctest-helper
`;
test('parses build processes, including compiler variants, without matching argument mentions', () => {
  const processes = parseBuildProcesses(sample);
  assert.deepEqual(processes.map(p => p.pid), [102, 105, 104, 101, 103]);
  assert.equal(processes[0].memoryBytes, 4096 * 1024);
  assert.equal(processes[0].cpuPercent, 120);
  assert.equal(processes[0].memoryPercent, 0.2);
  assert.equal(processes[0].elapsedSeconds, 64);
  assert.equal(processes[0].startedAt, new Date('Sat Oct 10 15:00:01 2026').toISOString());
  assert.equal(processes[0].command, '/usr/bin/g++ -c main.cpp');
  assert.deepEqual(parseBuildProcesses('\ninvalid\n'), []);
});
test('scans the host process table', async () => {
  assert.ok(Array.isArray(await scanBuildProcesses()));
});
test('process API returns snapshots and errors within existing origin protection', async () => {
  const monitor = new Monitor(configSchema.parse({ scriptsDirectory: '/absent', resources: [{ id: 'ai', name: 'AI', containerName: 'ai' }] }));
  let fail = false;
  const server = createServer(monitor, 'dist/public', undefined, async () => {
    if (fail) throw new Error('ps unavailable');
    return parseBuildProcesses(sample);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/build-processes`;
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { processes: parseBuildProcesses(sample), monitoredProcesses: monitor.config.monitoredProcesses });
    assert.equal((await fetch(url, { headers: { Origin: 'http://evil.example' } })).status, 403);
    fail = true;
    assert.equal((await fetch(url)).status, 500);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('filters using configured executable names and supports disabling monitoring', async () => {
  assert.deepEqual(parseBuildProcesses(sample, ['cmake']).map(p => p.pid), [101]);
  assert.deepEqual(parseBuildProcesses(sample, ['bash']).map(p => p.pid), [106]);
  assert.deepEqual(parseBuildProcesses(sample, ['gcc-14']).map(p => p.pid), [104]);
  assert.deepEqual(parseBuildProcesses(sample, []), []);
  assert.deepEqual(await scanBuildProcesses([]), []);
});
