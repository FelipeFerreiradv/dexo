import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { NfeDevolucaoUseCase } from "../../../app/usecases/nfe-devolucao.usecase";
import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import { modoReferenciaDevolucao } from "../../../app/fiscal/devolucao/modo-referencia";
import { devolucaoRefItemProdDesde } from "../../../app/fiscal/flags";
import { normalizarImpostoOriginal, proporcionalizar } from "../../../app/fiscal/devolucao/tributacao";

// Achado devolucao-2: o ambiente da validação (D19 / AMBIENTE_DIVERGENTE) e do modo de
// referência tem de sair da CONFIG ATUAL — é com ela que o orquestrador monta a chave
// fiscal —, não da LINHA do rascunho (ambiente da criação). Senão um rascunho criado em
// homologação, emitido depois da troca para produção, referencia nota sem valor fiscal.

const CFC = "cfg-kiko";
const CNPJ = "11386276000176";

function chave(numero: number): string {
  const base = "41" + "2609" + CNPJ + "55" + "001" + String(numero).padStart(9, "0") + "1" + "10000012";
  return base + calcularDvChaveAcesso(base)!;
}
const CHAVE_ORIGINAL = chave(7);

const tributacao = () =>
  proporcionalizar({
    impostoOriginal: normalizarImpostoOriginal({
      ICMS: { ICMSSN102: { orig: "0", CSOSN: "102" } },
      PIS: { PISOutr: { CST: "49", vBC: "0.00", pPIS: "0.00", vPIS: "0.00" } },
      COFINS: { COFINSOutr: { CST: "49", vBC: "0.00", pCOFINS: "0.00", vCOFINS: "0.00" } },
    }),
    qOriginal: 1,
    qDevolvida: 1,
    vUnCom: 100,
    crtEmitente: "1",
    crtOriginal: "1",
    tipoOperacao: "ENTRADA",
  });

/** Rascunho de devolução CRIADO em homologação (a linha guarda ambiente=HOMOLOGACAO). */
function persistida() {
  const item = { nItem: 1, codigo: "P1", descricao: "PECA TESTE", unidade: "UN", ncm: "87089990", cfop: "5102", quantidade: 1, valorUnitario: 100, desconto: 0, impostoOriginal: null, cest: null, origem: 0 };
  return {
    cabecalho: {
      nfeId: "dev-1", userId: "tenant", tipo: "VENDA_ENTRADA", fonte: "XML", escopoSolicitado: "TOTAL",
      devolvidaAposEntrega: true, confirmadoSemXml: false, indFinal: "HERDA", updatedAt: new Date(),
      origensJson: [{ originalNfeId: "orig-1", chaveAcesso: CHAVE_ORIGINAL, numero: 7, serie: 1, dataEmissao: "2026-09-20", idDest: 1, crtOriginal: "1", emitenteCnpj: CNPJ, itens: [item] }],
    },
    refs: [{
      ordem: 1, originalNfeId: "orig-1", chaveAcessoOriginal: CHAVE_ORIGINAL, nItemOriginal: 1, codigoOriginal: "P1",
      cfopOriginal: "5102", quantidadeOriginal: 1, valorUnitarioOriginal: 100, quantidade: 1, valor: 100,
      impostoOriginal: null, tributacao: tributacao(), cfopMapeamento: { status: "MAPEADO", opcoes: ["1202"] },
    }],
    nota: {
      id: "dev-1", userId: "tenant", companyFiscalConfigId: CFC, modelo: "55", serie: 1, numero: -1, status: "DRAFT",
      ambiente: "HOMOLOGACAO", finalidade: "DEVOLUCAO", tipoOperacao: "ENTRADA", destinoOperacao: "INTERNA",
      naturezaOperacao: "DEVOLUCAO DE VENDA", indPresenca: "NAO_SE_APLICA", destinatarioJson: { nome: "CLIENTE", cpfCnpj: "00000000000100" },
      pagamentosJson: [], xmlAutorizadoPath: null, protocoloAutorizacao: null,
      itens: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "1202", unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100, desconto: 0, origem: 0 }],
    },
  };
}

function useCase(ambienteConfig: "HOMOLOGACAO" | "PRODUCAO") {
  const dados = persistida();
  const repo = {
    db: { $queryRawUnsafe: async () => [{ chaveAcesso: CHAVE_ORIGINAL, status: "AUTHORIZED", ambiente: "HOMOLOGACAO" }] },
    nota: async () => dados.nota,
    get: async () => dados,
    linhasSaldo: async () => [],
  };
  const configs = {
    findByIdForUser: async () => ({ id: CFC, userId: "tenant", cnpj: CNPJ, ambiente: ambienteConfig, providerName: "FOCUS_NFE", providerToken: "tok", regimeTributario: "SIMPLES" }),
    findByUserId: async () => null,
  };
  return new NfeDevolucaoUseCase(repo as never, configs as never, {} as never);
}

beforeEach(() => {
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
  vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "true");
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
  vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", CFC);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("NfeDevolucaoUseCase.detalhe — ambiente vem da config atual", () => {
  it("config em HOMOLOGACAO (mesma da original): sem AMBIENTE_DIVERGENTE e emitível", async () => {
    const d = await useCase("HOMOLOGACAO").detalhe("tenant", "dev-1");
    expect(d.issues.map((i) => i.code)).not.toContain("AMBIENTE_DIVERGENTE");
    expect(d.podeEmitir).toBe(true);
    expect(d.modoReferencia).toBe(modoReferenciaDevolucao("HOMOLOGACAO", new Date(), devolucaoRefItemProdDesde()));
  });

  it("rascunho de homologação com a config já em PRODUCAO: AMBIENTE_DIVERGENTE bloqueia e o modo é o de produção", async () => {
    const d = await useCase("PRODUCAO").detalhe("tenant", "dev-1");
    expect(d.issues.filter((i) => i.severidade === "ERRO").map((i) => i.code)).toContain("AMBIENTE_DIVERGENTE");
    expect(d.podeEmitir).toBe(false);
    expect(d.modoReferencia).toBe(modoReferenciaDevolucao("PRODUCAO", new Date(), devolucaoRefItemProdDesde()));
  });

  it("contextoEmissao recusa a emissão do rascunho de outro ambiente (DEVOLUCAO_INVALIDA)", async () => {
    await expect(useCase("PRODUCAO").contextoEmissao("tenant", "dev-1")).rejects.toMatchObject({
      name: "DevolucaoError",
      code: "DEVOLUCAO_INVALIDA",
    });
  });
});
