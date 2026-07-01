import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset paths so the production build works when Electron loads it
  // via file:// (a leading-slash "/assets/..." would resolve to the FS root).
  base: './',
  plugins: [react()],
  server: { port: 5174 },
})
