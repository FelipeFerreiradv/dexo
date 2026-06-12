import type { NextConfig } from "next";

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
    key: "Permissions-Policy",
    value: "geolocation=(), microphone=(), camera=()",
  },
  // Report-Only: não bloqueia nada ainda (ver comentário acima).
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig: NextConfig = {
  // Enable React compiler optimizations (auto-memoization)
  reactStrictMode: true,
  // Compress responses
  compress: true,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  images: {
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
