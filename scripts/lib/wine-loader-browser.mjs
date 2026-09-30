import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { webgpuBrowserOptions } from './webgpu-browser.mjs';

const probes = {
  x87integer: { script: 'x87-integer-probe.js', entry: 'probeX87Integer' },
  sharedData: { script: 'shared-data-probe.js', entry: 'probeSharedData' },
  scalarSse: { script: 'scalar-sse-probe.js', entry: 'probeScalarSse' },
  x87trig: { script: 'x87-trig-probe.js', entry: 'probeX87Trig' },
  x87log: { script: 'x87-log-probe.js', entry: 'probeX87Log' },
  x87exp: { script: 'x87-exp-probe.js', entry: 'probeX87Exp' },
  x87scale: { script: 'x87-scale-probe.js', entry: 'probeX87Scale' },
  x87tan: { script: 'x87-tan-probe.js', entry: 'probeX87Tan' },
  com: { script: 'com-probe.js', entry: 'probeCom' },
  drivers: { script: 'driver-probe.js', entry: 'probeDrivers' },
  winmm: { script: 'winmm-probe.js', entry: 'probeWinmm' },
  loader: { script: 'wine-loader-probe.js', entry: 'probeWineLoader' },
  crt: { script: 'wine-crt-probe.js', entry: 'probeWineCrt' },
  target: { script: 'wine-target-probe.js', entry: 'probeWineTarget' },
};

// Local diagnostic inputs are supplied by the integrity-checked launchers.
// Reuse the same isolated worker/route boundary for every Wine probe; do not
// copy installed DLLs, NLS data or upstream application assets into public/.
async function probeInBrowser(root, kind, input) {
  const probe = probes[kind];
  const assets = new Map();
  const descriptors = {};
  for (const field of ['files', 'builtinFiles', 'nlsFiles']) {
    if (!input[field]) continue;
    descriptors[field] = [];
    for (const [name, bytes] of input[field]) {
      const key = `${field}/${name}`;
      assets.set(key, bytes);
      descriptors[field].push([name, key]);
    }
  }
  for (const field of ['dll', 'executable']) if (input[field]) assets.set(field, input[field]);
  const server = await createServer({
    root,
    base: '/',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    // The D3D12/DXGI target probe exercises real swap-chain presentation, so
    // launch with the same WebGPU flags the automated graphics fixtures use.
    browser = await chromium.launch({ ...webgpuBrowserOptions, headless: true });
    const context = await browser.newContext();
    const outbound = [];
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) {
        outbound.push(url.href);
        await route.abort();
      } else if (url.pathname.startsWith('/__wine_probe/')) {
        const bytes = assets.get(decodeURIComponent(url.pathname.slice('/__wine_probe/'.length)));
        await route.fulfill({
          status: bytes ? 200 : 404,
          body: bytes ? Buffer.from(bytes) : 'Missing probe asset',
          contentType: 'application/octet-stream',
        });
      } else await route.continue();
    });
    const page = await context.newPage();
    // A worker's console output does not reach the test process on its own;
    // forwarding it is what makes a diagnostic switch observable.
    if (process.env.WINEBROWSER_WORKER_LOG) {
      page.on('console', (message) => process.stderr.write(`[worker] ${message.text()}\n`));
    }
    await page.goto(origin + '/tests/fixtures/desktop-controls.html');
    const result = await page.evaluate(
      async (payload) => {
        if (!crossOriginIsolated) throw Error('Chromium probe is not cross-origin isolated');
        const source = `
        import { ${payload.probe.entry} as probe } from ${JSON.stringify(payload.origin + '/scripts/lib/' + payload.probe.script)};
        import { init } from ${JSON.stringify(payload.origin + '/vendor/iced.js')};
        onmessage = async ({data}) => {
          try {
            const fetchBytes = async key => {
              const response = await fetch(data.origin + '/__wine_probe/' + encodeURIComponent(key));
              if (!response.ok) throw Error('Probe asset unavailable: ' + key);
              return new Uint8Array(await response.arrayBuffer());
            };
            const input = {
              testStaticTLS: data.testStaticTLS,
              frameGoal: data.frameGoal,
              limits: data.limits,
              watchValue: data.watchValue,
              watchRange: data.watchRange,
              watchAnyRange: data.watchAnyRange,
            };

            for (const [field, entries] of Object.entries(data.descriptors))
              input[field] = new Map(await Promise.all(entries.map(async ([name,key]) => [name,await fetchBytes(key)])));
            for (const field of data.byteFields) input[field] = await fetchBytes(field);
            if (data.exe) input.exe = data.exe;
            const result = await probe(await init(), input);
            postMessage({...result, worker:true, crossOriginIsolated});
          } catch(error) { postMessage({status:'blocked',failure:{message:error.message,stack:error.stack}}); }
        };
      `;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Worker(url, { type: 'module' });
        try {
          return await new Promise((resolve, reject) => {
            // The guest budget is bounded by the probe's own diagnostic clock;
            // this only guards a wedged worker. Allow a generous margin so a
            // long block budget is not cut short by transport timeouts.
            const timeout = setTimeout(
              () => reject(Error('Wine worker probe timed out')),
              Number(payload.workerTimeoutMs) || 60000,
            );
            worker.onmessage = (event) => {
              clearTimeout(timeout);
              resolve(event.data);
            };
            worker.onerror = (event) => {
              clearTimeout(timeout);
              reject(Error(event.message));
            };
            worker.postMessage(payload);
          });
        } finally {
          worker.terminate();
          URL.revokeObjectURL(url);
        }
      },
      {
        origin,
        probe,
        descriptors,
        byteFields: ['dll', 'executable'].filter((field) => input[field]),
        exe: input.exe,
        testStaticTLS: input.testStaticTLS,
        frameGoal: input.frameGoal,
        workerTimeoutMs: input.workerTimeoutMs,
        limits: input.limits,
        watchValue: input.watchValue,
        watchRange: input.watchRange,
        watchAnyRange: input.watchAnyRange,
      },
    );
    if (result.worker !== true || result.crossOriginIsolated !== true)
      throw Error('Wine worker failed: ' + (result.failure?.message ?? 'missing worker result'));
    if (outbound.length) throw Error(`Unexpected outbound probe requests: ${outbound.join(', ')}`);
    return { ...result, browser: browser.version(), outboundRequests: outbound };
  } finally {
    await browser?.close();
    await server.close();
  }
}

export const probeWineLoaderInBrowser = (root, input) => probeInBrowser(root, 'loader', input);
export const probeWineCrtInBrowser = (root, input) => probeInBrowser(root, 'crt', input);
export const probeWineTargetInBrowser = (root, input) => probeInBrowser(root, 'target', input);
export const probeWinmmInBrowser = (root, input) => probeInBrowser(root, 'winmm', input);
export const probeComInBrowser = (root, input) => probeInBrowser(root, 'com', input);
export const probeDriversInBrowser = (root, input) => probeInBrowser(root, 'drivers', input);
export const probeX87LogInBrowser = (root, input) => probeInBrowser(root, 'x87log', input);
export const probeX87ExpInBrowser = (root, input) => probeInBrowser(root, 'x87exp', input);
export const probeX87ScaleInBrowser = (root, input) => probeInBrowser(root, 'x87scale', input);
export const probeX87TanInBrowser = (root, input) => probeInBrowser(root, 'x87tan', input);
export const probeX87TrigInBrowser = (root, input) => probeInBrowser(root, 'x87trig', input);
export const probeScalarSseInBrowser = (root, input) => probeInBrowser(root, 'scalarSse', input);

export const probeSharedDataInBrowser = (root, input) => probeInBrowser(root, 'sharedData', input);

export const probeX87IntegerInBrowser = (root, input) => probeInBrowser(root, 'x87integer', input);
