"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { MASCOT } from "./bitz-constants";

export type MascotState = "idle" | "thinking" | "error";

interface BitzMascotProps {
  size?: number;
  state?: MascotState;
  /** Aura em gradiente atrás do mascote (o "orbe" da referência). */
  aura?: boolean;
  className?: string;
  priority?: boolean;
}

/**
 * O mascote do Bitz.
 *
 * `<img>` puro, não `next/image`: o projeto roda com `images.unoptimized: true`
 * (next.config.ts:136), então o `next/image` aqui só acrescentaria wrapper e
 * JS sem entregar otimização nenhuma.
 *
 * A aura é a tradução do orbe iridescente da referência de design para a
 * identidade do Dexo — gradiente cônico sobre os tokens de marca, em vez do
 * lavanda da referência.
 *
 * TODA animação é gateada por `motion-reduce`. Este é o primeiro componente do
 * repositório a respeitar `prefers-reduced-motion` (grep confirma zero
 * ocorrências antes dele).
 */
export function BitzMascot({
  size = 44,
  state = "idle",
  aura = false,
  className,
  priority = false,
}: BitzMascotProps) {
  const src = size > 128 ? MASCOT.webp256 : MASCOT.webp128;
  const fallback = size > 128 ? MASCOT.png256 : MASCOT.png128;

  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      {aura && (
        <span
          aria-hidden
          className={cn(
            "absolute -inset-[18%] rounded-full opacity-70 blur-xl",
            "bg-[conic-gradient(from_140deg,var(--color-chart-1),var(--color-chart-3),var(--color-primary),var(--color-chart-2),var(--color-chart-1))]",
            state === "thinking" &&
              "animate-[bitz-aura_2.4s_ease-in-out_infinite] motion-reduce:animate-none",
          )}
        />
      )}

      <picture className="relative">
        <source srcSet={src} type="image/webp" />
        <img
          src={fallback}
          alt=""
          width={size}
          height={size}
          decoding="async"
          loading={priority ? "eager" : "lazy"}
          draggable={false}
          className={cn(
            "relative select-none object-contain",
            "drop-shadow-[0_6px_14px_rgba(14,31,42,0.28)]",
            state === "thinking" &&
              "animate-[bitz-bob_1.6s_ease-in-out_infinite] motion-reduce:animate-none",
          )}
          style={{ width: size, height: size }}
        />
      </picture>

      {state === "error" && (
        <span
          aria-hidden
          className="border-background bg-destructive absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2"
        />
      )}
    </span>
  );
}
