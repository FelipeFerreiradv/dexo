import Image from "next/image";
import { Boxes, ShoppingCart, Wallet } from "lucide-react";

import { cn } from "@/lib/utils";

const HIGHLIGHTS = [
  { icon: Boxes, title: "Estoque centralizado", active: true },
  { icon: ShoppingCart, title: "Vendas integradas", active: false },
  { icon: Wallet, title: "Financeiro & fiscal", active: false },
] as const;

interface DexoLoginAsideProps {
  className?: string;
}

export function DexoLoginAside({ className }: DexoLoginAsideProps) {
  return (
    <aside
      className={cn(
        "relative isolate flex-col justify-between gap-10 overflow-hidden p-8 sm:p-10",
        className,
      )}
    >
      {/* Brilho gold sobre escuro (tradução do verde da imagem) */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-20"
        style={{
          background:
            "radial-gradient(circle at 22% 18%, color-mix(in oklab, var(--primary) 26%, transparent), transparent 55%), radial-gradient(circle at 82% 88%, color-mix(in oklab, var(--accent) 18%, transparent), transparent 52%), color-mix(in oklab, var(--foreground) 5%, var(--background))",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute -inset-[20%] -z-10 animate-orbit-slow opacity-25 blur-[70px]"
        style={{
          background:
            "conic-gradient(from 120deg at 50% 50%, color-mix(in oklab, var(--primary) 40%, transparent) 0deg, color-mix(in oklab, var(--accent) 34%, transparent) 130deg, color-mix(in oklab, var(--ring) 30%, transparent) 250deg, transparent 320deg, color-mix(in oklab, var(--primary) 36%, transparent) 360deg)",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_120%,rgba(0,0,0,0.45),transparent_60%)]"
      />

      {/* Marca: tile claro com a logo + wordmark */}
      <div className="flex items-center gap-3">
        <div className="size-12 shrink-0 overflow-hidden rounded-xl bg-foreground shadow-[0_18px_50px_-30px_rgba(0,0,0,0.85)] ring-1 ring-border/40">
          <Image
            src="/logo.jpg"
            alt="Dexo"
            width={48}
            height={48}
            className="size-full object-contain p-1"
            priority
          />
        </div>
        <span className="text-xl font-semibold tracking-tight text-foreground">
          Dexo
        </span>
      </div>

      {/* Headline + subtitulo + destaques do produto */}
      <div className="space-y-6">
        <div className="max-w-sm space-y-3">
          <h2 className="text-3xl font-bold leading-tight tracking-tight text-foreground sm:text-4xl">
            Tudo do seu negócio
            <br className="hidden sm:block" /> num só lugar
          </h2>
          <p className="text-sm leading-relaxed text-foreground/70">
            Estoque, vendas e financeiro de desmontes e autopeças em um só
            lugar.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {HIGHLIGHTS.map(({ icon: Icon, title, active }) => (
            <div
              key={title}
              className={cn(
                "flex flex-col gap-3 rounded-2xl p-4 transition-colors",
                active
                  ? "bg-foreground text-background shadow-[0_22px_60px_-34px_rgba(0,0,0,0.85)]"
                  : "border border-border/40 bg-background/40 text-foreground/70 backdrop-blur-sm",
              )}
            >
              <Icon
                className={cn(
                  "h-5 w-5",
                  active ? "text-background" : "text-primary",
                )}
                aria-hidden="true"
              />
              <span className="text-xs font-medium leading-snug">{title}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
