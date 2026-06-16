// Hard refresh: tear down anything that could serve stale content — service
// workers and the Cache Storage API — then reload with a cache-busting query
// param so the HTML itself is re-fetched from the network.
export async function hardRefresh() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    // Cleanup is best-effort; reload regardless so the button always "works".
    console.warn('[hard-refresh] cleanup failed:', err);
  }
  const url = new URL(window.location.href);
  url.searchParams.set('_', Date.now().toString(36));
  window.location.replace(url.toString());
}
