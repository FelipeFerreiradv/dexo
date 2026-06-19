import type { NextConfig } from "next";
import { execSync } from "node:child_process";

// Id único por build, agnóstico de deploy. Prioriza dados da Vercel; cai para
// git short SHA; sempre concatena um timestamp para garantir que TODO rebuild
// (mesmo do mesmo commit) gere um valor diferente — é isso que dispara o aviso
// de "nova versão" no UpdateNotifier.
const BUILD_COMMIT =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
  (() => {
    try {
      return execSync("git rev-parse --short HEAD").toString().trim();
    } catch {
      return "dev";
    }
  })();
const BUILD_ID = `${BUILD_COMMIT}-${Date.now()}`;

// Host do backend (serve as imagens em /uploads). Derivado das envs públicas;
// usado para estreitar o remotePattern de imagem (em vez do antigo "**").
function backendImagePatterns() {
  const raw =
    process.env.NEXT_PUBLIC_API_URL || process.env.APP_BACKEND_URL || "";
  try {
    if (raw) {
      const u = new URL(raw);
      return [
        {
          protocol: (u.protocol.replace(":", "") || "https") as
            | "http"
            | "https",
          hostname: u.hostname,
          ...(u.port ? { port: u.port } : {}),
          pathname: "/uploads/**",
        },
      ];
    }
  } catch {
    /* env malformada: cai no fallback abaixo */
  }
  // Fallback (host não determinável no build): mantém o comportamento amplo
  // para NÃO quebrar o carregamento de imagens. Estreite definindo
  // NEXT_PUBLIC_API_URL no build.
  return [
    {
      protocol: "https" as const,
      hostname: "**",
      pathname: "/uploads/**",
    },
  ];
}

// CSP em Report-Only: reporta violações sem BLOQUEAR (zero regressão). Depois
// de validar nos relatórios, troque o header para "Content-Security-Policy"
// (enforce). Inclui as fontes conhecidas (self, API, Supabase Storage, mlstatic).
const apiOrigin = (() => {
  try {
    return process.env.NEXT_PUBLIC_API_URL
      ? new URL(process.env.NEXT_PUBLIC_API_URL).origin
      : "";
  } catch {
    return "";
  }
})();

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https://*.supabase.co http://http2.mlstatic.com https://http2.mlstatic.com ${apiOrigin}`,
  "font-src 'self' data:",
  `connect-src 'self' https://*.supabase.co ${apiOrigin}`,
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
]
  .join("; ")
  .replace(/\s+/g, " ")
  .trim();

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // camera=(self): o scanner de código de barras (/scan, @zxing/browser) usa
    // a câmera na PRÓPRIA origem. camera=() (allowlist vazia) bloquearia o
    // getUserMedia e quebraria o scanner. Mantém microphone/geolocation off.
    key: "Permissions-Policy",
    value: "geolocation=(), microphone=(), camera=(self)",
  },
  // Report-Only: não bloqueia nada ainda (ver comentário acima).
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig: NextConfig = {
  // Enable React compiler optimizations (auto-memoization)
  reactStrictMode: true,
  // Compress responses
  compress: true,
  // Migrado do next.config.mjs legado (removido nesta unificação). O projeto
  // tem ~107 erros de TS pré-existentes; sem ignoreBuildErrors o `next build`
  // passaria a typecheckar e quebraria. Mantém o build idêntico ao de produção.
  typescript: {
    ignoreBuildErrors: true,
  },
  // Sinal de versão p/ o UpdateNotifier (poll em /api/version), inlinado em
  // cliente e servidor. NÃO sobrescreve o build id interno do Next.
  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  images: {
    // Migrado do .mjs legado: imagens servidas sem otimização do Next. Evita
    // quebrar imagens dinâmicas (product.imageUrl de Supabase/Shopee/ML) que
    // NÃO estão nos remotePatterns abaixo. Habilitar a otimização (remover
    // unoptimized) exige antes auditar/incluir todos os hosts => follow-up.
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "http",
        hostname: "localhost",
        port: "3333",
        pathname: "/uploads/**",
      },
      ...backendImagePatterns(),
      {
        protocol: "http",
        hostname: "http2.mlstatic.com",
      },
    ],
  },
  // Enable build-time optimizations
  experimental: {
    optimizePackageImports: ["lucide-react", "@radix-ui/react-icons"],
  },
};

export default nextConfig;
