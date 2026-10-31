import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const DAEMON = 'http://127.0.0.1:4780';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // The proxy below rewrites Origin, so the daemon's guard can't tell another site from this one. This has to refuse them.
    cors: false,
    proxy: {
      '/api': { target: DAEMON, changeOrigin: true, headers: { origin: DAEMON } },
    },
  },
});
