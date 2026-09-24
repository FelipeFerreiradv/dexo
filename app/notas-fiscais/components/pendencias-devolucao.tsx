"use client";

// React explicito, como no `step-impostos.tsx` e no `ajuste-numeracao-card.tsx`
// ao lado: o tsconfig usa jsx em modo preserve, entao o esbuild do vitest
// compila o JSX para o React.createElement classico e o componente so monta em
// jsdom com o React em escopo. Em producao o Next segue com o runtime automatico.
import * as React from "react";
import { AlertTriangle, Info } from "lucide-react";
import {
  COMO_RESOLVER_SEM_DETALHE,
  TITULO_AVISOS,
  type PendenciaDevolucao,
  type PendenciasDevolucaoView,
} from "../lib/nfe-devolucao-pendencias-ui";

/**
 * O quadro do que falta para a devolucao poder ser emitida. So desenha: quem
 * decide o texto e o tom e `lib/nfe-devolucao-pendencias-ui` (modulo puro,
 * testado em node) — a mesma divisao do `nfe-aviso-emissao` com o
 * `step-finalizar`.
 *
 * Dois lugares o usam, de proposito:
 *   * `devolucao-editor.tsx` — a PREVIA (`DevolucaoDetalhe.issues`), que ela ve
 *     a cada "Salvar devolucao", no passo em que o conserto e feito;
 *   * `nfe-wizard.tsx` — o BLOQUEIO da emissao (422 DEVOLUCAO_INVALIDA), no
 *     passo em que ela clicou "Emitir NF-e". Toast nao segura uma lista: ele
 *     continua avisando que falhou, e o quadro diz o que falta e onde.
 */

const CORES = {
  bloqueio: {
    caixa: "border-amber-500/40 bg-amber-500/10",
    titulo: "text-amber-800",
    texto: "text-amber-700",
    fraco: "text-amber-700/80",
    marcador: "marker:text-amber-700",
  },
  aviso: {
    caixa: "border-blue-500/40 bg-blue-500/10",
    titulo: "text-blue-700",
    texto: "text-blue-600",
    fraco: "text-blue-600/80",
    marcador: "marker:text-blue-600",
  },
} as const;

export function PendenciasDevolucao({
  view,
  className = "",
}: {
  view: PendenciasDevolucaoView;
  className?: string;
}) {
  const c = CORES[view.tom];
  return (
    <div
      role="alert"
      aria-label="Pendências da devolução"
      className={`rounded-lg border p-4 text-left ${c.caixa} ${className}`}
    >
      <div className="flex items-center gap-2">
        {view.bloqueado ? (
          <AlertTriangle className={`size-4 shrink-0 ${c.texto}`} />
        ) : (
          <Info className={`size-4 shrink-0 ${c.texto}`} />
        )}
        <p className={`text-sm font-semibold ${c.titulo}`}>
          {view.bloqueios.length > 0 ? view.titulo : view.mensagem}
        </p>
      </div>

      {/* Bloqueio sem lista: a frase do servidor ja foi para o titulo; aqui vai
          para onde olhar. O bloqueio NAO some por falta de detalhe. */}
      {view.semDetalhe && (
        <p className={`mt-2 text-sm ${c.texto}`}>{COMO_RESOLVER_SEM_DETALHE}</p>
      )}

      {view.bloqueios.length > 0 && (
        <ol className={`mt-3 list-decimal space-y-3 pl-5 ${c.marcador}`}>
          {view.bloqueios.map((p, i) => (
            <li key={`${p.codigo ?? "?"}-${i}`}>
              <Linha pendencia={p} cores={c} />
            </li>
          ))}
        </ol>
      )}

      {view.avisos.length > 0 && (
        <>
          {view.bloqueios.length > 0 && (
            <p className={`mt-4 text-sm font-semibold ${c.titulo}`}>{TITULO_AVISOS}</p>
          )}
          <ul className={`mt-2 list-disc space-y-2 pl-5 ${c.marcador}`}>
            {view.avisos.map((p, i) => (
              <li key={`${p.codigo ?? "?"}-${i}`}>
                <Linha pendencia={p} cores={c} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Linha({
  pendencia,
  cores,
}: {
  pendencia: PendenciaDevolucao;
  cores: (typeof CORES)[keyof typeof CORES];
}) {
  return (
    <>
      <p className={`text-sm font-medium ${cores.titulo}`}>{pendencia.titulo}</p>
      {pendencia.comoResolver !== "" && (
        <p className={`mt-0.5 text-sm ${cores.texto}`}>{pendencia.comoResolver}</p>
      )}
      {/* O motivo cru do servidor (por que a tributacao pede revisao, por
          exemplo): detalhe, nao instrucao — menor e por ultimo. */}
      {pendencia.detalhes.map((d) => (
        <p key={d} className={`mt-0.5 text-xs ${cores.fraco}`}>
          {d}
        </p>
      ))}
    </>
  );
}
