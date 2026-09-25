// @vitest-environment jsdom
//
// O passo "Finalizar" montado DE VERDADE, para duas coisas novas:
//
//  1. Devolução: o VALOR DA NOTA que a emissão vai calcular (vNF), com o IPI
//     devolvido — a soma dos produtos que a tela mostrava não o inclui. Os
//     números vêm do servidor (`DevolucaoDetalhe.totais`, a mesma conta da
//     emissão); com item ainda por fechar, a tela diz que é PRÉVIA.
//  2. Multi-CNPJ: o aviso de ambiente lê a empresa DO RASCUNHO. Lendo a padrão
//     (GET /fiscal/config), um tenant com dois CNPJs em ambientes diferentes
//     via "produção" onde era homologação, ou o contrário.
//
// Sem `companyFiscalConfigId` nem `totaisDevolucao` a tela é a de antes — os
// specs vizinhos (`conferencia-valores-finalizar-tela`, `nfe-aviso-emissao-tela`)
// continuam valendo sem mudança.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", () => ({ getApiBaseUrl: () => "http://api.test" }));

import { StepFinalizar } from "../../../app/notas-fiscais/components/steps/step-finalizar";
import type { TotaisDevolucao } from "../../../app/fiscal/devolucao/tipos";

const DLS = {
  serie: 1,
  tipoOperacao: "SAIDA",
  finalidade: "DEVOLUCAO",
  destinoOperacao: "INTERNA",
  naturezaOperacao: "Devolucao de compra",
  modalidadeFrete: "SEM_FRETE",
  destinatario: { nome: "DISAUTO DISTRIBUIDORA", cpfCnpj: "11222333000181" },
  itens: [{ numero: 1, descricao: "Farol direito", quantidade: 1, valorUnitario: 664.58, valorTotal: 664.58 }],
  pagamentos: [{ meio: "SEM_PAGAMENTO", valor: 0 }],
};

const TOTAIS: TotaisDevolucao = {
  totalProdutos: 664.58,
  totalDesconto: 0,
  totalFrete: 0,
  totalBcIcms: 664.58,
  totalIcms: 79.75,
  totalPis: 0,
  totalCofins: 0,
  totalIpiDevol: 33.23,
  totalNota: 697.81,
  completo: true,
  itensPendentes: [],
};

let container: HTMLDivElement;
let root: Root;
let chamadas: string[];
let respostas: Record<string, unknown>;

const texto = () => container.textContent ?? "";

async function montar(props: Record<string, unknown>) {
  await act(async () => {
    root.render(<StepFinalizar getValues={(() => DLS) as never} {...(props as object)} />);
  });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  chamadas = [];
  respostas = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    chamadas.push(url);
    const body = respostas[url];
    if (body === undefined) throw new Error(`chamada inesperada a ${url}`);
    return { ok: true, status: 200, json: async () => body };
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Finalizar — valor da nota de devolução", () => {
  it("mostra o valor que a nota vai ter, com o IPI devolvido", async () => {
    await montar({ totaisDevolucao: TOTAIS });
    const quadro = container.querySelector('[aria-label="Valor da nota de devolucao"]')!;
    expect(quadro.textContent).toContain("Valor da nota de devolução");
    expect(quadro.textContent).toContain("IPI devolvido: R$ 33,23");
    expect(quadro.textContent).toContain("ICMS: R$ 79,75");
    expect(quadro.textContent).toContain("Valor da nota: R$ 697,81");
    expect(quadro.textContent).not.toContain("prévia");
  });

  it("item por fechar ⇒ diz que é PRÉVIA e quais itens", async () => {
    await montar({ totaisDevolucao: { ...TOTAIS, completo: false, itensPendentes: [2, 5] } });
    expect(texto()).toContain("Valor da nota de devolução (prévia)");
    expect(texto()).toContain("os itens 2, 5 ainda não fecham");
  });

  it("sem os totais (NF-e comum) ⇒ o quadro não existe", async () => {
    await montar({});
    expect(container.querySelector('[aria-label="Valor da nota de devolucao"]')).toBeNull();
  });
});

describe("Finalizar — ambiente da empresa DO RASCUNHO (multi-CNPJ)", () => {
  it("lê a empresa do rascunho na lista de empresas, não a padrão (filial em homologação)", async () => {
    respostas["http://api.test/fiscal/companies"] = {
      companies: [
        { id: "padrao", ambiente: "PRODUCAO" },
        { id: "filial", ambiente: "HOMOLOGACAO" },
      ],
    };
    await montar({ email: "dona@dls.test", companyFiscalConfigId: "filial", ambienteRascunho: "HOMOLOGACAO" });
    expect(chamadas).toEqual(["http://api.test/fiscal/companies"]);
    expect(texto().toLowerCase()).toContain("homologação");
    expect(texto()).not.toContain("PRODUÇÃO");
  });

  it("filial em PRODUÇÃO com a padrão em homologação: diz produção (a padrão mentiria 'teste')", async () => {
    respostas["http://api.test/fiscal/companies"] = {
      companies: [
        { id: "padrao", ambiente: "HOMOLOGACAO" },
        { id: "filial", ambiente: "PRODUCAO" },
      ],
    };
    await montar({ email: "dona@dls.test", companyFiscalConfigId: "filial", ambienteRascunho: "HOMOLOGACAO" });
    expect(texto().toLowerCase()).toContain("produção");
    expect(texto().toLowerCase()).not.toContain("homologação");
  });

  it("empresa não achada ⇒ NÃO cai na padrão: fica neutro", async () => {
    respostas["http://api.test/fiscal/companies"] = { companies: [{ id: "padrao", ambiente: "HOMOLOGACAO" }] };
    await montar({ email: "dona@dls.test", companyFiscalConfigId: "sumiu", ambienteRascunho: "HOMOLOGACAO" });
    expect(chamadas).toEqual(["http://api.test/fiscal/companies"]);
    expect(texto().toLowerCase()).not.toContain("sem valor fiscal");
  });

  it("sem empresa do rascunho ⇒ o GET /fiscal/config de sempre", async () => {
    respostas["http://api.test/fiscal/config"] = { config: { ambiente: "PRODUCAO" } };
    await montar({ email: "dona@dls.test" });
    expect(chamadas).toEqual(["http://api.test/fiscal/config"]);
  });
});
