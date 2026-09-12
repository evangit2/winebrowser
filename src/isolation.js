// Static hosts such as GitHub Pages cannot set COOP/COEP themselves. Reuse the
// upstream worker, but wait for it to control this page before reloading.
export async function ensureIsolation() {
  const reloadKey = `winebrowser:isolation:${import.meta.env.BASE_URL}`;
  if (crossOriginIsolated) {
    sessionStorage.removeItem(reloadKey);
    return;
  }
  if (!isSecureContext || !navigator.serviceWorker)
    throw Error('Browser isolation requires HTTPS and service worker support');
  if (sessionStorage.getItem(reloadKey)) {
    sessionStorage.removeItem(reloadKey);
    throw Error('Browser isolation could not be enabled. Reload the page to retry.');
  }

  const workerURL = new URL(`${import.meta.env.BASE_URL}coi-serviceworker.js`, location.origin);
  await navigator.serviceWorker.register(workerURL, { updateViaCache: 'none' });
  await new Promise((resolve, reject) => {
    const controlled = () => navigator.serviceWorker.controller?.scriptURL === workerURL.href;
    const cleanup = () => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', changed);
    };
    const changed = () => {
      if (!controlled()) return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error('The isolation worker did not start. Reload the page to retry.'));
    }, 15000);
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    changed();
  });
  sessionStorage.setItem(reloadKey, '1');
  location.reload();
  // The next document initializes the harness under the worker's COOP/COEP headers.
  await new Promise(() => {});
}
