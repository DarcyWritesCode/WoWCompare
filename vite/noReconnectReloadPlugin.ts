import type { Plugin } from 'vite';

/**
 * WoWCompare: the dev server, opened through a reverse proxy, loses its HMR socket whenever the
 * tab sleeps (switching tabs, a phone locking), and Vite's client reloads the page once it
 * reconnects, which throws away a running sim. This keeps the page instead; edits made meanwhile
 * need a manual reload. Only applied when the server answers to extra hosts (DEV_ALLOWED_HOSTS).
 */
const RECONNECT_RELOAD = /(await waitForSuccessfulPing\([^)]*\);\s*)location\.reload\(\);/;

export default function noReconnectReloadPlugin(): Plugin {
  return {
    name: 'wowcompare-no-reconnect-reload',
    apply: 'serve',
    transform(code, id) {
      if (!process.env.DEV_ALLOWED_HOSTS || !id.includes('vite/dist/client/client.mjs')) {
        return null;
      }
      if (!RECONNECT_RELOAD.test(code)) {
        this.warn("Vite's client changed: the reload on reconnect wasn't found to remove.");
        return null;
      }
      return code.replace(
        RECONNECT_RELOAD,
        '$1console.log("[vite] reconnected; reload to pick up changes.");',
      );
    },
  };
}
