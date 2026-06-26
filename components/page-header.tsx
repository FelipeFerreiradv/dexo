import * as React from "react";

import { cn } from "@/lib/utils";

// clamp = "grandão" no desktop sem quebrar no mobile (mesmo do herói de Pedidos).
const HERO_TITLE_SIZE = { fontSize: "clamp(3rem, 13vw, 9.5rem)" } as const;

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  pills?: React.ReactNode;
  className?: string;
}

/**
 * Cabeçalho de página com título "wordmark" `<título>.` na fonte Outfit:
 * palavra em petróleo (`--foreground`) + ponto em amarelo (`--primary`).
 *
 * Layout adaptativo:
 * - SEM `actions` → herói centralizado grandão (igual à página de Pedidos).
 * - COM `actions` → título à esquerda + botões à direita (preserva o fluxo das
 *   páginas que têm ações no cabeçalho).
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  pills,
  className,
}: PageHeaderProps) {
  // Wordmark na fonte Outfit (var global do layout). `style` (fontFamily) vence
  // a regra base `h1 { font-family: var(--font-display) }`.
  const titleNode = (sizeClass: string, sizeStyle?: React.CSSProperties) => (
    <h1
      className={cn(
        "select-none text-balance font-black lowercase leading-[0.9] tracking-[-0.04em] text-foreground",
        sizeClass,
      )}
      style={{ fontFamily: "var(--font-outfit)", ...sizeStyle }}
    >
      {title}
      <span className="text-primary">.</span>
    </h1>
  );

  // Com botões de ação: layout à esquerda + ações à direita.
  if (actions) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-4",
          className,
        )}
      >
        <div className="min-w-0 space-y-1">
          {eyebrow && (
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80">
              {eyebrow}
            </p>
          )}
          {titleNode("break-words text-3xl sm:text-4xl")}
          {subtitle && (
            <p className="max-w-3xl pt-1 text-sm text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pills}
          {actions}
        </div>
      </div>
    );
  }

  // Padrão: herói centralizado (mesmo desenho da página de Pedidos).
  return (
    <header className={cn("space-y-3 py-2 text-center", className)}>
      {eyebrow && (
        <p className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
          {eyebrow}
        </p>
      )}
      {titleNode("px-2", HERO_TITLE_SIZE)}
      {pills && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {pills}
        </div>
      )}
      {subtitle && (
        <p className="mx-auto mt-10 max-w-2xl text-sm text-muted-foreground">
          {subtitle}
        </p>
      )}
    </header>
  );
}
