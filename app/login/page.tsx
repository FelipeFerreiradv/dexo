import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { DexoHero } from "@/components/login/dexo-hero";
import { DexoLoginForm } from "@/components/login/dexo-login-form";

export const metadata = {
  title: "Dexo | Entrar",
  description: "Tela de login premium da Dexo com visual imersivo.",
};

export default function LoginPage() {
  return (
    <main className="dark relative isolate flex min-h-screen w-full flex-col items-center overflow-hidden bg-background text-foreground">
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

      <div className="relative z-10 flex min-h-screen w-full max-w-[480px] flex-col items-center px-5 pb-10 pt-6 sm:px-7">
        <header className="flex w-full items-center justify-start">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="Voltar"
          >
            <ChevronLeft className="h-5 w-5" />
            <span>Voltar</span>
          </Link>
        </header>

        <div className="flex w-full flex-1 flex-wrap items-center justify-center gap-8 py-6 sm:gap-10 sm:flec-co">
          <div className="flex w-full justify-center">
            <DexoHero />
          </div>

          <div className="space-y-2 text-center">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Dexo
            </h1>
            <p className="text-sm text-muted-foreground">
              Acesse com seguranca para continuar.
            </p>
          </div>

          <div className="w-full">
            <DexoLoginForm />
          </div>
        </div>
      </div>
    </main>
  );
}
