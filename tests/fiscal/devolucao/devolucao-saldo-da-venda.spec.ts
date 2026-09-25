import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NfeDevolucaoUseCase } from "../../../app/usecases/nfe-devolucao.usecase";
import { parseNfeXml } from "../../../app/fiscal/sefaz/nfe-xml-parser.service";
import type { LinhaSaldoDevolucao } from "../../../app/fiscal/devolucao/saldo";
import { ITENS_DISAUTO, configDls, linha, stubFlags, xmlCompraDisauto } from "./devolucao-caso-de-uso-fixtures";

// GET /fiscal/nfe/:id/devolucao/saldo — a ficha da venda chama em TODA abertura desde o #375
// (componente DevolucaoVinculo). O caso de uso não tinha teste. E fazia uma consulta por
// devolução ligada à nota (repo.nota: a linha inteira e todos os itens) só para ler nº, série
// e status — que o linhasSaldo já traz pelo mesmo JOIN (regra de egress 5).

const ORIGINAL = {
  id: "venda-1", userId: "tenant", companyFiscalConfigId: "cfg-dls", modelo: "55", status: "AUTHORIZED",
  finalidade: "NORMAL", tipoOperacao: "SAIDA", xmlAutorizadoPath: "/x.xml",
  destinatarioJson: { nome: "Cliente Balcão", cpfCnpj: "52998224725" },
};

function montar(linhas: LinhaSaldoDevolucao[], notas: Record<string, { numero: number; serie: number; status: string }> = {}) {
  const chamadasNota: string[] = [];
  const repo = {
    linhasSaldo: async () => linhas,
    nota: async (_u: string, id: string) => { chamadasNota.push(id); return notas[id] ?? null; },
  };
  const uc = new NfeDevolucaoUseCase(repo as never, {} as never, {} as never);
  // A leitura da ORIGINAL (nota, config, XML) não é o que está sob teste aqui.
  (uc as unknown as { original: () => Promise<unknown> }).original = async () => ({
    n: ORIGINAL, c: configDls(), parsed: parseNfeXml(xmlCompraDisauto(ITENS_DISAUTO)),
  });
  return { uc, chamadasNota };
}

beforeEach(() => {
  stubFlags();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("saldo da venda (ficha da nota)", () => {
  const COM_DADOS = [
    linha(6, 1, "AUTHORIZED", { devolucaoNfeId: "dev-717", numeroDevolucao: 717, serieDevolucao: 1 }),
    linha(5, 1, "AUTHORIZED", { devolucaoNfeId: "dev-717", numeroDevolucao: 717, serieDevolucao: 1 }),
    linha(4, 1, "DRAFT", { devolucaoNfeId: "dev-rasc", numeroDevolucao: -40, serieDevolucao: 1 }),
  ];

  it("lista as devoluções com nº, série e status sem nenhuma consulta por devolução", async () => {
    const { uc, chamadasNota } = montar(COM_DADOS);
    const r = await uc.saldo("tenant", "venda-1");
    expect(chamadasNota).toEqual([]);
    expect(r.devolucoes).toEqual([
      { nfeId: "dev-717", numero: 717, serie: 1, status: "AUTHORIZED", itens: [{ nItem: 6, quantidade: 1 }, { nItem: 5, quantidade: 1 }] },
      // Rascunho: nº negativo é placeholder, não número fiscal.
      { nfeId: "dev-rasc", numero: null, serie: 1, status: "DRAFT", itens: [{ nItem: 4, quantidade: 1 }] },
    ]);
  });

  it("mesma resposta que o caminho antigo (repo.nota por devolução), campo a campo", async () => {
    const semDados = COM_DADOS.map(({ numeroDevolucao: _n, serieDevolucao: _s, ...l }) => l as LinhaSaldoDevolucao);
    const antigo = montar(semDados, {
      "dev-717": { numero: 717, serie: 1, status: "AUTHORIZED" },
      "dev-rasc": { numero: -40, serie: 1, status: "DRAFT" },
    });
    const novo = montar(COM_DADOS);
    const a = await antigo.uc.saldo("tenant", "venda-1");
    const b = await novo.uc.saldo("tenant", "venda-1");
    expect(antigo.chamadasNota).toEqual(["dev-717", "dev-rasc"]);
    expect(novo.chamadasNota).toEqual([]);
    expect(b).toEqual(a);
  });

  it("linha com nº mas sem série: não inventa a série — busca a nota, como antes", async () => {
    const { uc, chamadasNota } = montar([linha(6, 1, "AUTHORIZED", { devolucaoNfeId: "dev-x", numeroDevolucao: 717 })], {
      "dev-x": { numero: 717, serie: 2, status: "AUTHORIZED" },
    });
    const r = await uc.saldo("tenant", "venda-1");
    expect(chamadasNota).toEqual(["dev-x"]);
    expect(r.devolucoes).toEqual([{ nfeId: "dev-x", numero: 717, serie: 2, status: "AUTHORIZED", itens: [{ nItem: 6, quantidade: 1 }] }]);
  });

  it("linha sem nº/série (leitor antigo): cai no caminho de antes e some a devolução que não existe mais", async () => {
    const semDados = [linha(6, 1, "AUTHORIZED", { devolucaoNfeId: "sumiu" })];
    const { uc, chamadasNota } = montar(semDados, {});
    const r = await uc.saldo("tenant", "venda-1");
    expect(chamadasNota).toEqual(["sumiu"]);
    expect(r.devolucoes).toEqual([]);
  });
});
