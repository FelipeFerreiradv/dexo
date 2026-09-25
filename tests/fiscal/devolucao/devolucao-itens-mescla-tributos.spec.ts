import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { NfeDevolucaoUseCase } from "../../../app/usecases/nfe-devolucao.usecase";
import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import {
  aplicarOverrideTributacao,
  normalizarImpostoOriginal,
  proporcionalizar,
} from "../../../app/fiscal/devolucao/tributacao";

// Regressão de produção (DLS AUTO PEÇAS, 24/09/2026, rascunho 4a3698ee): salvar UM
// tributo apagava os outros que ela já tinha ajustado. O caso de uso fazia
// `override: b.tributacao ?? saved` — o corpo com só o ICMS SUBSTITUÍA o ajuste salvo
// inteiro, e o servidor refazia PIS/COFINS a partir do XML do FORNECEDOR (regime
// normal, CST 01 a 1,65%/7,6%). Numa empresa do Simples isso sai AUTORIZADO — não
// existe regra da SEFAZ cruzando CST de PIS com o regime — e só se desfaz cancelando.
//
// O cenário é o dela: devolução de COMPRA à DISAUTO, item 6 (bomba de óleo), ICMS 00
// a 12% e PIS/COFINS 01 na nota de compra; ela ajustou para CSOSN 900 a 12% e
// PIS/COFINS 49 a 0%, e depois voltou ao passo de impostos para mexer só num deles.

const CFC = "cfg-dls";
const CNPJ_DLS = "57502966000144";
const CNPJ_DISAUTO = "80689839000975";

function chave(numero: number): string {
  const base = "42" + "2609" + CNPJ_DISAUTO + "55" + "001" + String(numero).padStart(9, "0") + "1" + "75799182";
  return base + calcularDvChaveAcesso(base)!;
}
const CHAVE_COMPRA = chave(852899);

// A nota de compra da DISAUTO, item 6, como veio no XML (regime normal).
const IMPOSTO_ORIGINAL = normalizarImpostoOriginal({
  ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: "295.88", pICMS: "12.00", vICMS: "35.51" } },
  PIS: { PISAliq: { CST: "01", vBC: "260.37", pPIS: "1.65", vPIS: "4.30" } },
  COFINS: { COFINSAliq: { CST: "01", vBC: "260.37", pCOFINS: "7.60", vCOFINS: "19.79" } },
});

const baseDoItem = () =>
  proporcionalizar({
    impostoOriginal: IMPOSTO_ORIGINAL,
    qOriginal: 1,
    qDevolvida: 1,
    vUnCom: 295.88,
    crtEmitente: "1",
    crtOriginal: "3",
    tipoOperacao: "SAIDA",
  });

/** O ajuste que ela JÁ tinha gravado: CSOSN 900 a 12% e PIS/COFINS 49 a 0%. */
function ajusteGravado() {
  const r = aplicarOverrideTributacao({
    base: baseDoItem(),
    override: { icms: { csosn: "900", cst: null, pICMS: 12 }, pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } },
    confirmar: false,
    crtEmitente: "1",
    baseCalculoItem: 295.88,
    tipoOperacao: "SAIDA",
  });
  if (!r.ok) throw new Error("fixture inválida: " + r.erros.join("; "));
  return r.tributacao;
}

function persistida() {
  const item = {
    nItem: 6, codigo: "24171-7", descricao: "10255 SCHADEK BOMBA OLEO", unidade: "UN", ncm: "84133090",
    cfop: "5102", quantidade: 1, valorUnitario: 295.88, desconto: 0, impostoOriginal: IMPOSTO_ORIGINAL, cest: null, origem: 0,
  };
  return {
    cabecalho: {
      nfeId: "dev-dls", userId: "tenant", tipo: "COMPRA_SAIDA", fonte: "XML_IMPORTADO", escopoSolicitado: "PARCIAL",
      devolvidaAposEntrega: true, confirmadoSemXml: false, indFinal: "0", updatedAt: new Date(),
      origensJson: [{
        originalNfeId: null, chaveAcesso: CHAVE_COMPRA, numero: 852899, serie: 1, dataEmissao: "2026-09-10",
        idDest: 1, crtOriginal: "3", emitenteCnpj: CNPJ_DISAUTO, itens: [item],
      }],
    },
    refs: [{
      ordem: 1, originalNfeId: null, chaveAcessoOriginal: CHAVE_COMPRA, nItemOriginal: 6, codigoOriginal: "24171-7",
      cfopOriginal: "5102", quantidadeOriginal: 1, valorUnitarioOriginal: 295.88, quantidade: 1, valor: 295.88,
      impostoOriginal: IMPOSTO_ORIGINAL, tributacao: ajusteGravado(), cfopMapeamento: { status: "MAPEADO", opcoes: ["5202"] },
    }],
    nota: { id: "dev-dls", userId: "tenant", companyFiscalConfigId: CFC, modelo: "55", serie: 1, numero: -40, status: "DRAFT", ambiente: "PRODUCAO" },
  };
}

function montar() {
  const dados = persistida();
  const gravados: Array<{ refs: Array<{ tributacao: ReturnType<typeof ajusteGravado> }> }> = [];
  const repo = {
    get: async () => dados,
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    lockOrigens: async () => undefined,
    lockRascunho: async () => undefined,
    linhasSaldo: async () => [],
    gravarItens: async (_tx: unknown, _u: string, _id: string, _itens: unknown, refs: never) => { gravados.push({ refs }); },
    audit: async () => undefined,
  };
  const configs = {
    findByIdForUser: async () => ({ id: CFC, userId: "tenant", cnpj: CNPJ_DLS, ambiente: "PRODUCAO", providerName: "SEFAZ_DIRECT", regimeTributario: "SIMPLES" }),
    findByUserId: async () => null,
  };
  const uc = new NfeDevolucaoUseCase(repo as never, configs as never, {} as never);
  // O fim do método relê o detalhe inteiro; aqui só importa o que foi GRAVADO.
  (uc as unknown as { detalhe: () => Promise<null> }).detalhe = async () => null;
  const salvar = (tributacao: Record<string, unknown>) =>
    uc.itens("tenant", "tenant", "dev-dls", {
      itens: [{ chaveAcesso: CHAVE_COMPRA, nItem: 6, quantidade: 1, cfop: "5202", tributacao, confirmarTributacao: false }],
    } as never);
  const gravado = () => gravados[gravados.length - 1].refs[0].tributacao;
  return { salvar, gravado };
}

beforeEach(() => {
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
  vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", CFC);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("salvar um tributo não apaga os outros que ela já ajustou (DLS, 24/09)", () => {
  it("fixture: o ajuste gravado é mesmo CSOSN 900 a 12% com PIS/COFINS 49 a 0%", () => {
    const t = ajusteGravado();
    expect(t.fonte).toBe("USUARIO");
    expect(t.icms).toMatchObject({ csosn: "900", tag: "ICMSSN900", pICMS: 12 });
    expect(t.pis).toMatchObject({ cst: "49", p: 0 });
    expect(t.cofins).toMatchObject({ cst: "49", p: 0 });
  });

  it("mexer SÓ no ICMS mantém o PIS/COFINS 49 a 0% — não volta ao 01 a 1,65%/7,6% da DISAUTO", async () => {
    const { salvar, gravado } = montar();
    await salvar({ icms: { csosn: "900", cst: null, pICMS: 12 } });
    const t = gravado();
    expect(t.pis).toMatchObject({ cst: "49", p: 0 });
    expect(t.cofins).toMatchObject({ cst: "49", p: 0 });
    expect(t.pis.v).toBe(0);
    expect(t.cofins.v).toBe(0);
  });

  it("mexer SÓ no PIS mantém o CSOSN 900 a 12% — não volta ao CST 00 do fornecedor", async () => {
    const { salvar, gravado } = montar();
    await salvar({ pis: { cst: "49", p: 0 } });
    const t = gravado();
    expect(t.icms).toMatchObject({ csosn: "900", tag: "ICMSSN900", pICMS: 12 });
    expect(t.cofins).toMatchObject({ cst: "49", p: 0 });
  });

  it("o tributo que VEM no corpo substitui o salvo inteiro: CSOSN novo não arrasta a alíquota antiga para dentro", async () => {
    const { salvar, gravado } = montar();
    // Troca 900 → 102. Mesclar DENTRO do grupo deixaria {cst:null, csosn:"102", pICMS:12};
    // o grupo do corpo tem de valer sozinho, e o 102 não leva alíquota.
    await salvar({ icms: { csosn: "102", cst: null } });
    const t = gravado();
    expect(t.icms).toMatchObject({ csosn: "102", tag: "ICMSSN102" });
    expect(t.pis).toMatchObject({ cst: "49", p: 0 });
  });
});
