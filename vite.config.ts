import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages(https://<user>.github.io/mochi/)에서는 하위 경로로 서빙됨
export default defineConfig(({ command }) => ({
  base: command === 'build' && process.env.GITHUB_PAGES ? '/mochi/' : '/',
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
}))
