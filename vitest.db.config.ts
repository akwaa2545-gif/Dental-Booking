import{defineConfig}from'vitest/config';
export default defineConfig({test:{environment:'node',include:['tests/db/**/*.test.ts'],fileParallelism:false,hookTimeout:30000,testTimeout:15000}});
