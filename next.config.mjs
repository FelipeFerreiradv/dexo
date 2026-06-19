import { execSync } from "node:child_process"

// Id único por build, agnóstico de deploy. Prioriza dados da Vercel; cai para
// git short SHA; sempre concatena um timestamp para garantir que TODO rebuild
// (mesmo do mesmo commit) gere um valor diferente — é isso que dispara o aviso
// de "nova versão" no UpdateNotifier.
const BUILD_COMMIT =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
  (() => {
    try {
      return execSync("git rev-parse --short HEAD").toString().trim()
    } catch {
      return "dev"
    }
  })()
const BUILD_ID = `${BUILD_COMMIT}-${Date.now()}`

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Sinal de versão independente, embutido no cliente e no servidor, consumido
  // pelo UpdateNotifier via poll a /api/version. NÃO sobrescreve o build id
  // interno do Next (hashes de chunk seguem intactos => zero regressão).
  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },
}

export default nextConfig
