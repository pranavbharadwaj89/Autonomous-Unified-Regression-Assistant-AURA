import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendUrl = env.VITE_BACKEND_URL || 'http://127.0.0.1:9090'
  const qaRunnerUrl = env.VITE_QA_RUNNER_URL || 'http://127.0.0.1:3001'

  return {
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true,
          proxyTimeout: 300000,
          timeout: 300000,
        },
        '/health': {
          target: backendUrl,
          changeOrigin: true,
        },
        '/qa-runner': {
          target: qaRunnerUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/qa-runner/, ''),
        },
      },
    },
  }
})
