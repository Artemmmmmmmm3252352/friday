import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    ...(await electron({
      main: {
        entry: 'electron/main.ts',
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
      },
    })),
  ],
  resolve: {
    alias: {
      '@': path.join(__dirname, 'src'),
      '@shared': path.join(__dirname, 'src/shared'),
      '@contracts': path.join(__dirname, 'packages/contracts/src'),
      '@electron': path.join(__dirname, 'electron'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'electron/**/*.test.ts', 'apps/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['dist/**', 'dist-electron/**', 'dist-server/**', 'node_modules/**', 'vendor/**', 'tmp/**'],
  },
}))
