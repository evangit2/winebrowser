import { defineConfig } from 'vite';
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'X-Content-Type-Options': 'nosniff',
};
export default defineConfig({
  server: { headers },
  preview: { headers },
  worker: { format: 'es' },
  build: { target: 'esnext' },
});
