import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, open } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
const suite = JSON.parse(await readFile('runtime/test-suites/static-host.json'));
const pkg = JSON.parse(await readFile('package.json'));
const all = Object.values(suite.groups)
  .flat()
  .filter((row) => row.script);
assert.equal(all.length, suite.distinctInvocations);
assert.equal(new Set(all.map((row) => JSON.stringify(row))).size, all.length);
for (const row of all) assert.ok(pkg.scripts[row.script], 'Unknown script ' + row.script);
const original = await readFile('runtime/test-suites/static-host-original.txt', 'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'), suite.originalStaticBlockSha256);
const retained = new Set(all.map((row) => JSON.stringify(row)));
for (const line of original.split('\n')) {
  const match = line.match(/\bnpm run ([-:\w]+)/);
  if (!match) continue;
  const env = Object.fromEntries(
    [...line.slice(0, match.index).matchAll(/([A-Z_]+)=([^ ]+)/g)].map((m) => [m[1], m[2]]),
  );
  delete env.WINEBROWSER_TEST_URL;
  const row = { script: match[1] };
  if (Object.keys(env).length) row.env = env;
  assert.ok(retained.has(JSON.stringify(row)), 'Missing original check: ' + line.trim());
}
const group = process.argv[2];
if (group === '--check') {
  console.log(
    JSON.stringify({
      groups: Object.keys(suite.groups),
      distinctInvocations: all.length,
      originalInvocations: suite.originalInvocations,
      removedExactDuplicates: suite.removedExactDuplicates,
    }),
  );
  process.exit(0);
}
assert.ok(suite.groups[group], 'Choose one group from ' + Object.keys(suite.groups).join(', '));
const directory = '.scratch/ci-logs/' + group;
await mkdir(directory, { recursive: true });
let server;
const runs = [];
try {
  let url = process.env.WINEBROWSER_TEST_URL;
  if (!url) {
    server = spawn(process.execPath, ['scripts/serve-pages.mjs'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    server.on('error', (error) => {
      throw error;
    });
    url = 'http://127.0.0.1:4193/winebrowser/';
    let ready = false;
    for (let i = 0; i < 100; i++) {
      assert.equal(server.exitCode, null, 'static server exited before readiness');
      try {
        if ((await fetch(url)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'static server did not become ready');
  }
  for (const [index, row] of suite.groups[group].entries()) {
    const name = row.script || row.command.join(' ');
    const logPath = `${directory}/${String(index).padStart(2, '0')}.log`;
    const log = await open(logPath, 'w');
    const command = row.command || ['npm', 'run', row.script];
    const start = performance.now();
    console.log(`${group}: ${name} started`);
    const child = spawn(command[0], command.slice(1), {
      stdio: ['ignore', log.fd, log.fd],
      timeout: 15 * 60 * 1000,
      env: { ...process.env, WINEBROWSER_TEST_URL: url, ...row.env },
    });
    let exitCode, signal;
    try {
      [exitCode, signal] = await once(child, 'exit');
    } finally {
      await log.close();
    }
    const elapsedMs = performance.now() - start;
    runs.push({ ...row, exitCode, signal, elapsedMs, logPath });
    console.log(
      `${group}: ${name} ${exitCode === 0 ? 'passed' : 'FAILED'} (${(elapsedMs / 1000).toFixed(1)} s)`,
    );
    if (exitCode !== 0) {
      console.error((await readFile(logPath, 'utf8')).slice(-20000));
      throw Error(`${name} exited ${exitCode}, signal ${signal}; full output is ${logPath}`);
    }
  }
} finally {
  if (server) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  await writeFile(
    `evidence/ci-static-${group}.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        group,
        status:
          runs.length === suite.groups[group].length && runs.every((r) => r.exitCode === 0)
            ? 'passed'
            : 'failed',
        sourceWorkflowCommit: suite.sourceWorkflowCommit,
        runs,
      },
      null,
      2,
    ) + '\n',
  );
}
