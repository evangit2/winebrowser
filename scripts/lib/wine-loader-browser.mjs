import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const probes = {
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
    browser = await chromium.launch({
      channel: process.env.BROWSER_CHANNEL || 'chrome',
      headless: true,
    });
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
            const input = {};
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
            const timeout = setTimeout(() => reject(Error('Wine worker probe timed out')), 60000);
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
