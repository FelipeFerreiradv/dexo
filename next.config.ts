import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// O build id é gerado UMA vez por build (scripts/generate-build-id.mjs, antes do
// `next build`) e gravado em .build-id. Lê-se SEMPRE desse arquivo para que
// TODAS as avaliações do config (workers de build do cliente/servidor e o
// próprio `next start`) usem o MESMO valor. Se usássemos Date.now() aqui, cada
// avaliação geraria um timestamp diferente → o cliente embute um e o servidor
// responde outro → o aviso de "nova versão" reaparece em loop. Fallback (ex.:
// `next dev` sem prebuild): sha do git (estável entre avaliações); por fim "dev".
function resolveBuildId(): string {
  try {
    const fromFile = readFileSync(".build-id", "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    /* arquivo ausente (ex.: dev sem prebuild) */
  }
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev";
  }
}
const BUILD_ID = resolveBuildId();

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
