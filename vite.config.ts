import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Build-time choice: production never imports any synthetic adapter or identity UI.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@app-entry': fileURLToPath(new URL(process.env.APP_BUILD === 'demo' ? './src/demo/DemoApp.tsx' : './src/web/production.tsx', import.meta.url)) } },
  server: { host: '127.0.0.1' },
});
