import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` MUST match the ingress path prefix the SPA is served under.
// Phase 2 (transitional): served at /admin2/ while admin-dashboard still owns /.
// Phase 3: swap to '/' and retire admin-dashboard.
export default defineConfig({
  plugins: [react()],
  base: '/admin2/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
