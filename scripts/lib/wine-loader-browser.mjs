import { chromium } from '@playwright/test';
import { createServer } from 'vite';

// Serve only the caller's verified artifacts through an intercepted local
// route. Nothing is copied into public/ or included in the Pages build.
export async function probeWineLoaderInBrowser(root, { files, dll, nlsFiles }) {
  const assets = new Map([['ntdll.dll', dll]]);
  for (const [name, bytes] of files) assets.set('files/' + name, bytes);
  for (const [name, bytes] of nlsFiles) assets.set('nls/' + name, bytes);
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
      } else if (url.pathname.startsWith('/__wine_loader/')) {
        const bytes = assets.get(url.pathname.slice('/__wine_loader/'.length));
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
      async ({ origin, fileNames, nlsNames }) => {
        if (!crossOriginIsolated) throw Error('Chromium probe is not cross-origin isolated');
        const source = `
        import { probeWineLoader } from ${JSON.stringify(origin + '/scripts/lib/wine-loader-probe.js')};
        import { init } from ${JSON.stringify(origin + '/vendor/iced.js')};
        onmessage = async ({data}) => {
          try {
            const fetchBytes = async name => {
              const response = await fetch(data.origin + '/__wine_loader/' + name);
              if (!response.ok) throw Error('Probe asset unavailable: ' + name);
              return new Uint8Array(await response.arrayBuffer());
            };
            const files = new Map(await Promise.all(data.fileNames.map(async name => [name, await fetchBytes('files/' + name)])));
            const nlsFiles = new Map(await Promise.all(data.nlsNames.map(async name => [name, await fetchBytes('nls/' + name)])));
            const result = await probeWineLoader(await init(), { files, nlsFiles, dll: await fetchBytes('ntdll.dll') });
            postMessage({...result, worker: true, crossOriginIsolated});
          } catch(error) { postMessage({status:'blocked', failure:{message:error.message, stack:error.stack}}); }
        };
      `;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Worker(url, { type: 'module' });
        try {
          return await new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(Error('Wine loader worker probe timed out')),
              60000,
            );
            worker.onmessage = (event) => {
              clearTimeout(timeout);
              resolve(event.data);
            };
            worker.onerror = (event) => {
              clearTimeout(timeout);
              reject(Error(event.message));
            };
            worker.postMessage({ origin, fileNames, nlsNames });
          });
        } finally {
          worker.terminate();
          URL.revokeObjectURL(url);
        }
      },
      { origin, fileNames: [...files.keys()], nlsNames: [...nlsFiles.keys()] },
    );
    if (outbound.length) throw Error(`Unexpected outbound probe requests: ${outbound.join(', ')}`);
    return { ...result, browser: await browser.version(), outboundRequests: outbound };
  } finally {
    await browser?.close();
    await server.close();
  }
}

export async function probeWineCrtInBrowser(root, { executable, builtinFiles, nlsFiles }) {
  const assets = new Map([['files/console.exe', executable]]);
  for (const [name, bytes] of builtinFiles) assets.set('builtins/' + name, bytes);
  for (const [name, bytes] of nlsFiles) assets.set('nls/' + name, bytes);
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
      } else if (url.pathname.startsWith('/__wine_crt/')) {
        const bytes = assets.get(url.pathname.slice('/__wine_crt/'.length));
        await route.fulfill({
          status: bytes ? 200 : 404,
          body: bytes ? Buffer.from(bytes) : 'Missing CRT probe asset',
          contentType: 'application/octet-stream',
        });
      } else await route.continue();
    });
    const page = await context.newPage();
    await page.goto(origin + '/tests/fixtures/desktop-controls.html');
    const result = await page.evaluate(
      async ({ origin, builtinNames, nlsNames }) => {
        if (!crossOriginIsolated) throw Error('Chromium probe is not cross-origin isolated');
        const source = `
          import { probeWineCrt } from ${JSON.stringify(origin + '/scripts/lib/wine-crt-probe.js')};
          import { init } from ${JSON.stringify(origin + '/vendor/iced.js')};
          onmessage = async ({data}) => {
            try {
              const fetchBytes = async name => {
                const response = await fetch(data.origin + '/__wine_crt/' + name);
                if (!response.ok) throw Error('CRT probe asset unavailable: ' + name);
                return new Uint8Array(await response.arrayBuffer());
              };
              const builtinFiles = new Map(await Promise.all(data.builtinNames.map(async name => [name, await fetchBytes('builtins/' + name)])));
              const nlsFiles = new Map(await Promise.all(data.nlsNames.map(async name => [name, await fetchBytes('nls/' + name)])));
              const result = await probeWineCrt(await init(), {
                executable: await fetchBytes('files/console.exe'), builtinFiles, nlsFiles,
              });
              postMessage({...result, worker: true, crossOriginIsolated});
            } catch(error) {
              postMessage({status:'blocked-guest', processExitCode:1, firstFailure:{phase:'worker', error:{name:error.name, message:error.message}, stack:error.stack}});
            }
          };
        `;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Worker(url, { type: 'module' });
        try {
          return await new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(Error('Wine CRT worker probe timed out')),
              60000,
            );
            worker.onmessage = (event) => {
              clearTimeout(timeout);
              resolve(event.data);
            };
            worker.onerror = (event) => {
              clearTimeout(timeout);
              reject(Error(event.message));
            };
            worker.postMessage({ origin, builtinNames, nlsNames });
          });
        } finally {
          worker.terminate();
          URL.revokeObjectURL(url);
        }
      },
      { origin, builtinNames: [...builtinFiles.keys()], nlsNames: [...nlsFiles.keys()] },
    );
    if (outbound.length) throw Error(`Unexpected outbound probe requests: ${outbound.join(', ')}`);
    return { ...result, browser: await browser.version(), outboundRequests: outbound };
  } finally {
    await browser?.close();
    await server.close();
  }
}
