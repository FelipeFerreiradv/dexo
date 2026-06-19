import Image from "next/image";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { DexoLoginAside } from "@/components/login/dexo-login-aside";
import { DexoLoginForm } from "@/components/login/dexo-login-form";

export const metadata = {
  title: "Entrar",
  description:
    "Acesse sua conta Dexo e gerencie seu estoque centralizado com integrações ao Mercado Livre e Shopee.",
};

interface LoginPageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

function sanitizeCallbackUrl(raw?: string): string {
  if (!raw || typeof raw !== "string") return "/";
  const trimmed = raw.trim();
  // Only accept relative paths starting with /
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
  return trimmed;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { callbackUrl: rawCallback } = await searchParams;
  const callbackUrl = sanitizeCallbackUrl(rawCallback);
  return (
    <main className="dark relative isolate flex min-h-screen w-full items-center justify-center overflow-hidden bg-background px-4 py-8 text-foreground sm:px-6">
      {/* Fundo ambiente: gradientes gold discretos atrás do cartão */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div
          className="absolute inset-0 opacity-70"
          style={{
            background:
              "radial-gradient(circle at 50% 18%, color-mix(in oklab, var(--primary) 16%, transparent), transparent 38%), radial-gradient(circle at 18% 65%, color-mix(in oklab, var(--accent) 12%, transparent), transparent 42%), radial-gradient(circle at 82% 68%, color-mix(in oklab, var(--ring) 15%, transparent), transparent 40%)",
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.22] blur-3xl"
          style={{
            background:
              "conic-gradient(from 140deg at 50% 45%, color-mix(in oklab, var(--primary) 35%, transparent) 0deg, color-mix(in oklab, var(--accent) 32%, transparent) 120deg, color-mix(in oklab, var(--ring) 30%, transparent) 250deg, transparent 320deg, color-mix(in oklab, var(--primary) 28%, transparent) 360deg)",
          }}
        />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(0,0,0,0.55),transparent_65%)]" />
      </div>

      {/* Voltar (discreto) */}
      <Link
        href="/"
        className="absolute left-4 top-4 z-20 inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label="Voltar"
      >
        <ChevronLeft className="h-5 w-5" />
        <span className="max-sm:sr-only">Voltar</span>
      </Link>

      {/* Cartão split-screen */}
      <div
        className="relative z-10 w-full max-w-5xl overflow-hidden rounded-3xl border border-border/60 shadow-[0_60px_140px_-60px_rgba(0,0,0,0.9)]"
        style={{
          background: "color-mix(in oklab, var(--foreground) 4%, var(--background))",
        }}
      >
        <div className="grid lg:grid-cols-2">
          {/* Painel esquerdo (marca + destaques) — só em telas largas */}
          <DexoLoginAside className="hidden lg:flex" />

          {/* Painel direito (formulário) */}
          <section className="flex min-w-0 flex-col justify-center gap-6 p-6 sm:p-10">
            {/* Marca compacta no mobile (substitui o painel esquerdo) */}
            <div className="flex items-center gap-3 lg:hidden">
              <div className="size-10 shrink-0 overflow-hidden rounded-lg bg-foreground ring-1 ring-border/40">
                <Image
                  src="/logo.jpg"
                  alt="Dexo"
                  width={40}
                  height={40}
                  className="size-full object-contain p-1"
                  priority
                />
              </div>
              <span className="text-lg font-semibold tracking-tight">Dexo</span>
            </div>

            <div className="space-y-1.5">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Entrar na sua conta
              </h1>
              <p className="text-sm text-muted-foreground">
                Acesse com seu e-mail e senha para continuar.
              </p>
            </div>

            <DexoLoginForm callbackUrl={callbackUrl} />
          </section>
        </div>
      </div>
    </main>
  );
}
