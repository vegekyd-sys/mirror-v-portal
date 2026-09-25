import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// `base` MUST match the ingress path prefix the SPA is served under.
// Phase 3: admin-web owns the site root (admin-dashboard retired).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: loadEnv(mode, process.cwd(), 'VITE_NEXUS_').VITE_NEXUS_ELASTIC === 'true' ? '/admin/' : '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
}));
