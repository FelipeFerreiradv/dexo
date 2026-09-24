// @vitest-environment jsdom
//
// O passo "Finalizar" montado DE VERDADE, so para o quadro de conferencia de
// valores.
//
// Por que existe, se `conferirValores` ja tem 17 testes: o vizinho
// `nfe-aviso-emissao-tela.spec.tsx` documenta, do mesmo dia, que "a funcao
// `avisoEmissao` ja tem 17 testes e nenhum deles teria pegado o defeito, porque
// o defeito estava em QUEM ALIMENTA a funcao". Aqui vale igual: se o componente
// esquecer de passar `finalidade` ou `pagamentos`, a funcao pura continua
// perfeita e a tela volta a acusar "Divergência nos valores" em toda devolucao
// — que e exatamente o defeito que segurou a DLS AUTO PEÇAS o dia inteiro.
//
// Sem `email` de proposito: sem ele o efeito da config nem chama `fetch` (ver
// step-finalizar.tsx), entao este arquivo mede o quadro de valores e nada mais.

import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { StepFinalizar } from "../../../app/notas-fiscais/components/steps/step-finalizar";

let container: HTMLDivElement;
let root: Root;

/**
 * O rascunho REAL da DLS: devolucao de compra da DISAUTO, 2 de 6 itens,
 * R$ 864,58 em produtos e `pagamentosJson = [{meio:"SEM_PAGAMENTO", valor:0}]`
 * — a forma que o `emissao.ts` grava e que vira <tPag>90</tPag>/<vPag>0.00</vPag>.
 */
const DLS = {
  serie: 1,
  tipoOperacao: "ENTRADA",
  finalidade: "DEVOLUCAO",
  destinoOperacao: "INTERNA",
  naturezaOperacao: "Devolucao de compra",
  modalidadeFrete: "SEM_FRETE",
  destinatario: { nome: "DISAUTO DISTRIBUIDORA", cpfCnpj: "11222333000181" },
  itens: [
    { numero: 1, descricao: "Farol direito", quantidade: 1, valorUnitario: 664.58, valorTotal: 664.58 },
    { numero: 2, descricao: "Lanterna traseira", quantidade: 1, valorUnitario: 200, valorTotal: 200 },
  ],
  pagamentos: [{ meio: "SEM_PAGAMENTO", valor: 0 }],
};

const texto = () => (container.textContent ?? "").toLowerCase();

async function montar(rascunho: unknown) {
  await act(async () => {
    root.render(<StepFinalizar getValues={(() => rascunho) as never} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("passo Finalizar — quadro de conferencia de valores", () => {
  it("DLS: devolucao sem pagamento ⇒ nenhum alarme de divergencia na tela", async () => {
    await montar(DLS);

    const t = texto();
    expect(t, "o alarme falso que segurou a cliente o dia inteiro").not.toContain("divergência");
    expect(t).not.toContain("divergencia");
    expect(t).not.toContain("diferença: r$");
    // E nao e que a tela quebrou: os totais continuam la, os dois iguais.
    expect(t).toContain("864,58");
  });

  it("devolucao COM pagamento lancado ⇒ a tela diz que esse dinheiro nao vai na nota", async () => {
    await montar({ ...DLS, pagamentos: [{ meio: "PIX", valor: 500 }] });

    const t = texto();
    expect(t).toContain("não vai nesta devolução");
    expect(t).toContain("tpag 90");
    expect(t).toContain("não impede a emissão");
    // Continua sem acusar divergencia: o assunto mudou, nao o alarme voltou.
    expect(t).not.toContain("divergência");
  });

  it("NOTA DE VENDA com pagamento faltando ⇒ o alarme SAI (a regressao obvia)", async () => {
    await montar({
      ...DLS,
      finalidade: "NORMAL",
      tipoOperacao: "SAIDA",
      naturezaOperacao: "Venda de mercadoria",
      pagamentos: [{ meio: "SEM_PAGAMENTO", valor: 0 }],
    });

    const t = texto();
    expect(t, "venda sem pagamento nao pode passar calada").toContain("divergência nos valores");
    expect(t).toContain("diferença: r$ 864,58");
    // O texto do descarte e so da devolucao: nao pode vazar para a venda.
    expect(t).not.toContain("não vai nesta devolução");
  });

  it("venda que fecha ⇒ tela limpa", async () => {
    await montar({
      ...DLS,
      finalidade: "NORMAL",
      tipoOperacao: "SAIDA",
      pagamentos: [{ meio: "PIX", valor: 864.58 }],
    });

    expect(texto()).not.toContain("divergência");
    expect(texto()).not.toContain("não vai nesta devolução");
  });
});
