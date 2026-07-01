import * as React from "react";

import { cn } from "@/lib/utils";

interface SectionHeadingProps {
  /** Sobre-título em mono/caixa-alta (ex.: "Pipeline · CRM de orçamentos"). */
  eyebrow?: string;
  /** Título principal (Bricolage display via regra global de headings). */
  title: React.ReactNode;
  /** Palavra de acento em Fraunces itálico verde (ex.: "orçamentos"). */
  accent?: React.ReactNode;
  /** Descrição curta em mono. */
  description?: React.ReactNode;
  className?: string;
}

/**
 * Cabeçalho de seção no padrão do "Funil de orçamentos" (CRM) — a assinatura
 * editorial-industrial da marca Dexo: barrinha Amarelo Sinalização + eyebrow
 * mono caixa-alta + título Bricolage com acento Fraunces itálico (Verde
 * Operação) + descrição mono. Só apresentação; use dentro de CardHeader ou solto.
 */
export function SectionHeading({
  eyebrow,
  title,
  accent,
  description,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {eyebrow ? (
        <span className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          <span
            className="h-[2px] w-6 rounded-full bg-gradient-to-r from-[#f2c419] to-[#f2c419]/20"
            aria-hidden
          />
          {eyebrow}
        </span>
      ) : null}
      <h2 className="text-xl leading-tight tracking-tight sm:text-2xl [font-family:var(--font-bricolage)]">
        {title}
        {accent ? (
          <>
            {" "}
            <span className="italic text-[#2c5f4f] [font-family:var(--font-fraunces)] dark:text-emerald-400">
              {accent}
            </span>
          </>
        ) : null}
      </h2>
      {description ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}
