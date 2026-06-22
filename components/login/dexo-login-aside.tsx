import Image from "next/image";
import { Boxes, ShoppingCart, Wallet } from "lucide-react";

import { cn } from "@/lib/utils";

const HIGHLIGHTS = [
  { number: 1, title: "Estoque centralizado", active: true },
  { number: 2, title: "Vendas integradas", active: false },
  { number: 3, title: "Financeiro & fiscal", active: false },
] as const;

interface DexoLoginAsideProps {
  className?: string;
}

export function DexoLoginAside({ className }: DexoLoginAsideProps) {
  return (
    <aside
      className={cn(
        "relative isolate flex-col items-center justify-end gap-10 overflow-hidden p-8 sm:p-10 lg:p-14",
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
      {/* <div className="flex items-center gap-3">
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
      </div> */}

      {/* Headline + subtitulo + destaques do produto */}
      <div className="max-w-md space-y-20 pb-10 lg:max-w-full">
        <div className="flex items-center justify-center gap-22">
          <h2 className="max-w-1/3 text-3xl font-normal leading-tight tracking-tight text-foreground sm:text-4xl lg:text-5xl">
            Tudo em um só lugar
          </h2>
          <p className="max-w-1/3 text-sm leading-tight text-foreground/70 lg:text-xl">
            Estoque, vendas e financeiro de desmontes e autopeças em um só
            lugar.
          </p>
        </div>

        <div className="flex items-center justify-center gap-3 w-full">
          {HIGHLIGHTS.map(({ number, title, active }) => (
            <div
              key={title}
              className={cn(
                "flex items-start justify-start rounded-[30px] p-16 w-1/4 transition-colors",
                active
                  ? "bg-foreground text-background shadow-[0_22px_60px_-34px_rgba(0,0,0,0.85)]"
                  : "border border-white/15 bg-white/10 text-foreground/85 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.15)] backdrop-blur-xl",
              )}
            >
              <div className="flex flex-col gap-3">
                <div
                  className={
                    active
                      ? "flex items-center justify-center w-[25px] h-[25px] gap-2 text-xs bg-black rounded-full text-white"
                      : "flex items-center justify-center w-[25px] h-[25px] gap-2 text-xs bg-white rounded-full text-black"
                  }
                >
                  {number}
                </div>
                <span className="text-normal font-medium leading-snug">
                  {title}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
