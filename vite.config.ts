import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { include: ['tests/**/*.test.ts'] },
});
