import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
    fs: {
      // The stream parser in ../shared is shared with the Worker.
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
  },
  test: {
    // jsdom, not happy-dom: DOMPurify's documentation recommends jsdom and
    // warns that happy-dom is not considered safe to sanitize with.
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
    restoreMocks: true,
  },
});
