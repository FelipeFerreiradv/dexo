// @vitest-environment jsdom
//
// O quadro das pendências MONTADO de verdade — mesmo motivo do
// `step-impostos-devolucao-nao-gerenciada.spec.tsx` ao lado: um teste que lê o
// módulo puro prova que o texto existe, não que ele chega à tela.
//
// O caso da DLS (24/09/2026): 6 itens com a tributação por confirmar. O que ela
// via era "A devolução tem pendências que impedem a emissão." e mais nada.
// Aqui se prova que a tela passa a dizer QUAL pendência, em QUAIS itens e o que
// fazer — e que uma lista vazia não faz o bloqueio desaparecer.

import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { PendenciasDevolucao } from "../../../app/notas-fiscais/components/pendencias-devolucao";
import {
  viewPendencias,
  viewPendenciasDoDetalhe,
  COMO_RESOLVER_SEM_DETALHE,
} from "../../../app/notas-fiscais/lib/nfe-devolucao-pendencias-ui";
import { DEVOLUCAO_ERRO_MENSAGEM } from "../../../app/fiscal/devolucao/contrato";
import type { DevolucaoIssue } from "../../../app/fiscal/devolucao/tipos";

const ISSUES_DLS: DevolucaoIssue[] = [1, 2, 3, 4, 5, 6].map((ordem) => ({
  code: "TRIBUTACAO_REVISAO_PENDENTE",
  severidade: "ERRO",
  ordem,
  mensagem: `Item ${ordem}: revise e confirme a tributação. O regime tributário do emitente difere do da nota original.`,
}));

let container: HTMLDivElement;
let root: Root;

const texto = () => container.textContent ?? "";

async function montar(no: React.ReactElement) {
  await act(async () => {
    root.render(no);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("quadro de pendências na tela — caso DLS AUTO PEÇAS", () => {
  it("diz o que falta, em quais itens e o que fazer", async () => {
    await montar(
      <PendenciasDevolucao
        view={viewPendencias(ISSUES_DLS, DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA)}
      />,
    );
    const t = texto();
    expect(t).toContain("Falta confirmar a tributação dos itens 1 a 6");
    expect(t).toContain('marque "Revisei a tributação deste item"');
    expect(t).toContain('clique em "Salvar devolução"');
    expect(t).toContain('"Impostos"');
    // O motivo cru do servidor não se perde — ele é o que ela leva ao contador.
    expect(t).toContain("O regime tributário do emitente difere do da nota original.");
    // Uma linha por pendência, não seis.
    expect(container.querySelectorAll("ol > li")).toHaveLength(1);
    // Continua sendo um alerta para leitor de tela.
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("aviso não se disfarça de impedimento", async () => {
    await montar(
      <PendenciasDevolucao
        view={viewPendencias([
          ...ISSUES_DLS,
          {
            code: "IBS_CBS_NAO_ENVIADO",
            severidade: "AVISO",
            ordem: 2,
            mensagem: "Item 2: IBS/CBS da nota original não é enviado na devolução.",
          },
        ])}
      />,
    );
    // O bloqueio numerado tem UMA entrada; o aviso vai para a outra lista.
    expect(container.querySelectorAll("ol > li")).toHaveLength(1);
    expect(container.querySelectorAll("ul > li")).toHaveLength(1);
    expect(texto()).toContain("não impedem a emissão");
  });

  it("lista vazia NÃO faz o bloqueio sumir da tela", async () => {
    await montar(
      <PendenciasDevolucao
        view={viewPendencias([], DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA)}
      />,
    );
    const t = texto();
    expect(t).toContain(DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA);
    expect(t).toContain(COMO_RESOLVER_SEM_DETALHE);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("prévia sem bloqueio não grita impedimento", async () => {
    await montar(
      <PendenciasDevolucao
        view={viewPendenciasDoDetalhe({
          podeEmitir: true,
          issues: [
            {
              code: "PAGAMENTO_SERA_90",
              severidade: "AVISO",
              mensagem: 'Nota de devolução não tem forma de pagamento: será enviado "Sem pagamento".',
            },
          ],
        })}
      />,
    );
    const t = texto();
    expect(t).toContain("Nada impede a emissão desta devolução");
    expect(t).not.toContain(DEVOLUCAO_ERRO_MENSAGEM.DEVOLUCAO_INVALIDA);
    expect(container.querySelectorAll("ol > li")).toHaveLength(0);
  });
});
