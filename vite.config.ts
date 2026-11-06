import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin, ViteDevServer } from 'vite'
import { defineConfig, loadEnv } from 'vite'

// Mounts api/clocked.ts at /api/clocked during `vite dev`, so local
// development needs no extra server. Production uses the Vercel function.
function devApi(): Plugin {
  return {
    name: 'dev-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/clocked', async (req, res) => {
        try {
          const mod = await server.ssrLoadModule('/api/clocked.ts')
          await mod.default(req, res)
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Make .env.local visible to the dev API route (server-side only).
  const env = loadEnv(mode, process.cwd(), '')
  for (const [k, v] of Object.entries(env)) {
    if (!(k in process.env) && v !== undefined) process.env[k] = v
  }
  return { plugins: [react(), tailwindcss(), devApi()] }
})
