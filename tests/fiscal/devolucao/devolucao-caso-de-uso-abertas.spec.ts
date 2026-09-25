/**
 * Rascunhos de devolução em aberto (K13 / N-completude-1): a lista de notas esconde
 * rascunho, e a DLS tinha 7 invisíveis — um deles (cmubl7is, feito à mão, SEM cabeçalho
 * de devolução) segura o nº 712 entre o 711 e o 713 autorizados. A lista nova traz os
 * dois tipos, com o número preso a cada um, para a tela oferecer continuar/descartar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CFC, casoDeUso, erroDe, repoEmMemoria, stubFlags } from "./devolucao-caso-de-uso-fixtures";

beforeEach(stubFlags);
afterEach(() => { vi.unstubAllEnvs(); });

const linhaAberta = (over: Record<string, unknown>) => ({
  id: "x", status: "DRAFT", tipoOperacao: "SAIDA", companyFiscalConfigId: CFC, createdAt: new Date("2026-09-24T20:44:00Z"), updatedAt: new Date("2026-09-24T22:12:00Z"),
  destinatarioNome: "DISAUTO", quantidadeItens: 2, tipo: "COMPRA_SAIDA", fonte: "XML_IMPORTADO",
  originais: [{ chaveAcesso: "42260980689839000975550010008528991757991829", numero: 852899, serie: 1 }], ...over,
});

function montar(linhas: unknown[], reservas: unknown[] = [], configs = [{ id: CFC, isDefault: true }]) {
  const { repo } = repoEmMemoria();
  const pedidas: string[][] = [];
  Object.assign(repo, {
    configsDoUsuario: async () => configs,
    abertasDoUsuario: async () => linhas,
    reservasVivas: async (_u: string, ids: string[]) => { pedidas.push(ids); return reservas; },
  });
  return { uc: casoDeUso(repo), pedidas };
}

describe("abertas(): rascunhos de devolução para continuar ou descartar", () => {
  it("lista o gerenciado e o feito à mão (sem cabeçalho), com o número preso a cada um", async () => {
    const { uc } = montar(
      [linhaAberta({ id: "8d269885" }), linhaAberta({ id: "cmubl7is", tipo: null, fonte: null, tipoOperacao: "ENTRADA", originais: [], quantidadeItens: 3 })],
      [{ nfeId: "cmubl7is", numero: 712, serie: 1, estado: "REJEITADO", ambiente: "PRODUCAO" }],
    );
    const r = await uc.abertas("tenant");
    expect(r.abertas).toEqual([
      {
        draftId: "8d269885", status: "DRAFT", gerenciada: true, tipo: "COMPRA_SAIDA", fonte: "XML_IMPORTADO", tipoOperacao: "SAIDA", destinatarioNome: "DISAUTO",
        originais: [{ chaveAcesso: "42260980689839000975550010008528991757991829", numero: 852899, serie: 1 }], quantidadeItens: 2,
        criadaEm: "2026-09-24T20:44:00.000Z", atualizadaEm: "2026-09-24T22:12:00.000Z", numeracao: null,
      },
      {
        draftId: "cmubl7is", status: "DRAFT", gerenciada: false, tipo: null, fonte: null, tipoOperacao: "ENTRADA", destinatarioNome: "DISAUTO",
        originais: [], quantidadeItens: 3, criadaEm: "2026-09-24T20:44:00.000Z", atualizadaEm: "2026-09-24T22:12:00.000Z",
        numeracao: { numero: 712, serie: 1, estado: "REJEITADO", ambiente: "PRODUCAO" },
      },
    ]);
  });

  it("rascunho de empresa com a devolução DESLIGADA não aparece (multi-CNPJ); sem empresa ligada: 404", async () => {
    const { uc, pedidas } = montar([linhaAberta({ id: "a" }), linhaAberta({ id: "b", companyFiscalConfigId: "outra" })], [], [{ id: CFC, isDefault: true }, { id: "outra", isDefault: false }]);
    const r = await uc.abertas("tenant");
    expect(r.abertas.map((a) => a.draftId)).toEqual(["a"]);
    expect(pedidas[0]).toEqual(["a"]);

    const semNenhuma = montar([linhaAberta({ id: "a" })], [], [{ id: "outra", isDefault: true }]);
    const e = await erroDe(semNenhuma.uc.abertas("tenant"));
    expect(e.httpStatus).toBe(404);
  });

  it("rascunho sem empresa gravada usa a empresa padrão", async () => {
    const { uc } = montar([linhaAberta({ id: "a", companyFiscalConfigId: null })]);
    expect((await uc.abertas("tenant")).abertas.map((a) => a.draftId)).toEqual(["a"]);
  });
});
