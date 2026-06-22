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
    <main className="dark relative isolate flex min-h-screen w-full items-center justify-center overflow-hidden bg-background p-2 text-foreground sm:p-3">
      {/* Voltar (discreto) */}
      {/* <Link
        href="/"
        className="absolute left-4 top-4 z-20 inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label="Voltar"
      >
        <ChevronLeft className="h-5 w-5" />
        <span className="max-sm:sr-only">Voltar</span>
      </Link> */}

      {/* Cartão split-screen — fundo transparente: o painel direito funde com a
          margem (mesmo bg-background); só o painel esquerdo (gold) se destaca. */}
      <div className="relative z-10 flex w-full max-w-[3000px] flex-col overflow-hidden rounded-3xl lg:min-h-[calc(100vh-1.5rem)]">
        <div className="grid flex-1 lg:grid-cols-[1.8fr_1fr]">
          {/* Painel esquerdo (marca + destaques) — só em telas largas */}
          <DexoLoginAside className="hidden lg:flex" />

          {/* Painel direito (formulário) */}
          <section className="flex min-w-0 flex-col justify-center p-6 sm:p-10 lg:p-14">
            <div className="mx-auto w-full max-w-md space-y-6 lg:max-w-lg">
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
                <span className="text-lg font-semibold tracking-tight">
                  Dexo
                </span>
              </div>

              <div className="flex flex-col justify-center items-center space-y-1.5 mb-24">
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  Entrar na sua conta
                </h1>
                <p className="text-sm text-muted-foreground">
                  Acesse com seu e-mail e senha para continuar.
                </p>
              </div>

              <DexoLoginForm callbackUrl={callbackUrl} />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
