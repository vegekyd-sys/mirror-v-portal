import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` MUST match the ingress path prefix the SPA is served under.
// Phase 3: admin-web owns the site root (admin-dashboard retired).
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
