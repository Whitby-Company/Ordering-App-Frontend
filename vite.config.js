import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Stamp each build with a unique id, baked into the app (__BUILD_ID__) and
// written to /version.json. A running (possibly stale) tab polls version.json;
// when its id differs from the app's baked-in id, a new deploy has happened and
// the app shows a one-time "app updated, refresh" notice.
function buildVersion() {
  const buildId = String(Date.now());
  return {
    name: 'build-version',
    config() {
      return { define: { __BUILD_ID__: JSON.stringify(buildId) } };
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildVersion()],
});
