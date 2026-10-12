import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/support/setup.ts'],
    include: ['tests/{unit,web,worker,demo}/**/*.{test,spec}.{ts,tsx}'],
    clearMocks: true,
  },
});
