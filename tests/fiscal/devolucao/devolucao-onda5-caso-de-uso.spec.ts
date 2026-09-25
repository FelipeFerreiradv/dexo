/**
 * Onda 5 da auditoria da NF-e de devolução — o CASO DE USO (grupo I2), com a DLS AUTO
 * PEÇAS (Simples, SC) devolvendo à DISAUTO (regime normal, SC) os itens 5 e 6 da
 * NF-e 852899.
 *
 * O que cada bloco prende:
 * - Decisão 5: um valor IGUAL ao já salvo não é ajuste novo — o rascunho 4a3698ee da DLS
 *   (PIS/COFINS 01 gravado no item 6, empresa do Simples) voltava 422 em TODO save do
 *   item, até de quantidade. A EMISSÃO continua barrada (validarDevolucao).
 * - Revisão de regressão (G2 #1): o escopo gravado na criação é o DERIVADO.
 * - Revisão de regressão (G2 #2): as recusas do PUT dos itens dizem a PEÇA (nItem + chave).
 * - G3→G2 #1 (K11): o detalhe devolve `itensForaDaDevolucao`, para a peça tirada voltar
 *   depois de recarregar.
 * - K6(3): devolução de venda pela CHAVE de nota do Dexo com XML guardado é recusada.
 * - G4 #3 (K12): /disponibilidade lista TODAS as empresas com a devolução ligada.
 * - `/abertas` sem a devolução ligada: 200 com lista vazia, sem consulta por requisição.
 * - G4 #4: ORIGINAL_COM_DEVOLUCAO cita a devolução (nº e id).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aplicarOverrideTributacao, normalizarImpostoOriginal, proporcionalizar } from "../../../app/fiscal/devolucao/tributacao";
import { NfeDevolucaoUseCase, erroOriginalComDevolucao } from "../../../app/usecases/nfe-devolucao.usecase";
import { NfeDevolucaoRepository } from "../../../app/fiscal/devolucao/devolucao.repository";
import type { ManualValidado } from "../../../app/fiscal/devolucao/contrato";
import {
  CFC, CHAVE_DISAUTO, CNPJ_DISAUTO, CNPJ_DLS, ITENS_DISAUTO, casoDeUso, chave, configDls, erroDe, linha, repoEmMemoria, stubFlags, xmlCompraDisauto,
} from "./devolucao-caso-de-uso-fixtures";

beforeEach(stubFlags);
afterEach(() => { vi.unstubAllEnvs(); });

// ───────────────────────────── rascunho persistido ─────────────────────────────

const ICMS00_01 = (vBC: number) => ({
  ICMS: { ICMS00: { orig: "0", CST: "00", modBC: "3", vBC: vBC.toFixed(2), pICMS: "12.00", vICMS: (vBC * 0.12).toFixed(2) } },
  PIS: { PISAliq: { CST: "01", vBC: vBC.toFixed(2), pPIS: "1.65", vPIS: (vBC * 0.0165).toFixed(2) } },
  COFINS: { COFINSAliq: { CST: "01", vBC: vBC.toFixed(2), pCOFINS: "7.60", vCOFINS: (vBC * 0.076).toFixed(2) } },
});

interface ItemFixture { nItem: number; codigo: string; vUn: number; imposto: unknown; qCom?: number }
const ITEM5: ItemFixture = { nItem: 5, codigo: "33603-3", vUn: 123.56, imposto: ICMS00_01(123.56) };
const ITEM6: ItemFixture = { nItem: 6, codigo: "24171-7", vUn: 295.88, imposto: ICMS00_01(295.88) };

function snapshot(i: ItemFixture, fonte: string) {
  const q = i.qCom ?? 1;
  return {
    nItem: i.nItem, codigo: i.codigo, descricao: "PECA " + i.codigo, ncm: "84133090", cest: null, unidade: "UN", cfop: "5102",
    quantidade: fonte === "MANUAL" ? 0 : q, valorUnitario: i.vUn, valorProduto: i.vUn * q, desconto: 0,
    origem: 0, impostoOriginal: normalizarImpostoOriginal(fonte === "MANUAL" ? null : i.imposto),
  };
}

function base(i: ItemFixture, crt = "1") {
  return proporcionalizar({ impostoOriginal: normalizarImpostoOriginal(i.imposto), qOriginal: i.qCom ?? 1, qDevolvida: 1, vUnCom: i.vUn, crtEmitente: crt, crtOriginal: "3", tipoOperacao: "SAIDA" });
}

/**
 * O que o rascunho 4a3698ee da DLS tem gravado no item 6: PIS/COFINS 01 (1,65% e 7,6%)
 * escolhidos por ELA (fonte USUARIO) antes de o Simples recusar o 01 — o ICMS é o da
 * derivação. Montado com o juiz do regime normal, que é como o 01 passou na época.
 */
function tributacaoGravadaPis01() {
  const r = aplicarOverrideTributacao({
    base: base(ITEM6), override: { pis: { cst: "01", p: 1.65 }, cofins: { cst: "01", p: 7.6 } },
    confirmar: false, crtEmitente: "3", baseCalculoItem: ITEM6.vUn, tipoOperacao: "SAIDA",
  });
  if (!r.ok) throw new Error("fixture: " + r.erros.join("; "));
  expect(r.tributacao.fonte).toBe("USUARIO");
  expect(r.tributacao.pis).toMatchObject({ cst: "01", p: 1.65 });
  return r.tributacao;
}

function persistida(o: { itens?: ItemFixture[]; salvos?: number[]; fonte?: string; tributacaoSalva?: Record<number, unknown> } = {}) {
  const itens = o.itens ?? [ITEM5, ITEM6];
  const fonte = o.fonte ?? "XML_IMPORTADO";
  const snap = itens.map((i) => snapshot(i, fonte));
  const salvos = o.salvos ?? itens.map((i) => i.nItem);
  const refs = salvos.map((nItem, k) => {
    const s = snap.find((x) => x.nItem === nItem)!;
    const it = itens.find((x) => x.nItem === nItem)!;
    return {
      ordem: k + 1, originalNfeId: null, chaveAcessoOriginal: CHAVE_DISAUTO, nItemOriginal: nItem, codigoOriginal: s.codigo, cfopOriginal: "5102",
      quantidadeOriginal: s.quantidade || null, valorUnitarioOriginal: s.valorUnitario, quantidade: 1, valor: s.valorUnitario,
      impostoOriginal: fonte === "MANUAL" ? null : s.impostoOriginal,
      tributacao: o.tributacaoSalva?.[nItem] ?? (fonte === "MANUAL" ? proporcionalizar({ impostoOriginal: null, qOriginal: null, qDevolvida: 1, vUnCom: it.vUn, crtEmitente: "1", crtOriginal: null, tipoOperacao: "SAIDA" }) : base(it)),
      cfopMapeamento: { status: "MAPEADO", opcoes: ["5202"], cfop: "5202" },
    };
  });
  return {
    cabecalho: {
      nfeId: "dev-dls", userId: "tenant", tipo: "COMPRA_SAIDA", fonte, escopoSolicitado: "PARCIAL", devolvidaAposEntrega: true,
      confirmadoSemXml: fonte === "MANUAL", indFinal: "0", updatedAt: new Date(),
      origensJson: [{ originalNfeId: null, chaveAcesso: CHAVE_DISAUTO, modelo: "55", numero: 852899, serie: 1, dataEmissao: "2026-09-10", idDest: 1, crtOriginal: "3", emitenteCnpjCpf: CNPJ_DISAUTO, itens: snap }],
    },
    refs,
    nota: {
      id: "dev-dls", userId: "tenant", companyFiscalConfigId: CFC, modelo: "55", serie: 1, numero: -40, status: "DRAFT", ambiente: "HOMOLOGACAO",
      finalidade: "DEVOLUCAO", tipoOperacao: "SAIDA", destinoOperacao: "INTERNA", valorFrete: null,
      destinatarioJson: { tipoPessoa: "PJ", cpfCnpj: CNPJ_DISAUTO, nome: "DISAUTO", uf: "SC", inscricaoEstadual: "258272414" },
      pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }], duplicatasJson: null, notasReferenciadasJson: null,
      itens: refs.map((r) => ({ numero: r.ordem, codigo: r.codigoOriginal, descricao: "PECA", ncm: "84133090", unidade: "UN", cfop: "5202", quantidade: 1, valorUnitario: r.valor, valorTotal: r.valor, desconto: 0 })),
    },
  };
}

function montar(o: Parameters<typeof persistida>[0] & { linhas?: ReturnType<typeof linha>[] } = {}) {
  const dados = persistida(o);
  const { repo, chamadas } = repoEmMemoria({ persistidas: { "dev-dls": dados }, linhas: o.linhas });
  const uc = casoDeUso(repo);
  // Um caso de uso só para salvar (o fim de itens() relê o detalhe, e aqui importa o GRAVADO).
  const salvar = (itens: Array<Record<string, unknown>>) => {
    const s = casoDeUso(repo);
    (s as unknown as { detalhe: () => Promise<null> }).detalhe = async () => null;
    return s.itens("tenant", "tenant", "dev-dls", { itens: itens.map((i) => ({ chaveAcesso: CHAVE_DISAUTO, quantidade: 1, cfop: "5202", ...i })) } as never);
  };
  return { uc, salvar, chamadas, dados };
}

// ───────────────────────────────── decisão 5 ─────────────────────────────────

describe("decisão 5: valor IGUAL ao salvo não é ajuste novo — não barra salvar outra coisa; a EMISSÃO continua barrando", () => {
  it("rascunho 4a3698ee: PIS/COFINS 01 gravado no item 6 (Simples); salvar só as QUANTIDADES grava (antes: 422 em todo save)", async () => {
    const { salvar, chamadas } = montar({ tributacaoSalva: { 6: tributacaoGravadaPis01() } });
    await salvar([{ nItem: 5 }, { nItem: 6 }]);
    expect(chamadas.gravados).toHaveLength(1);
    // Regravado COMO ESTÁ: o 01 dela continua lá (quem decide trocar é ela, no passo 8).
    const g = chamadas.gravados[0].refs.find((r: any) => r.nItemOriginal === 6).tributacao;
    expect(g.pis).toMatchObject({ cst: "01", p: 1.65 });
    expect(g.cofins).toMatchObject({ cst: "01", p: 7.6 });
  });

  it("…e a EMISSÃO continua barrada por ele: o detalhe aponta PIS_COFINS_REGIME_INCOMPATIVEL no item 2 e não deixa emitir", async () => {
    const { uc } = montar({ tributacaoSalva: { 6: tributacaoGravadaPis01() } });
    const d = await uc.detalhe("tenant", "dev-dls");
    expect(d.podeEmitir).toBe(false);
    const doItem = d.issues.filter((i) => i.ordem === 2 && i.code === "PIS_COFINS_REGIME_INCOMPATIVEL");
    expect(doItem.length).toBeGreaterThan(0);
    expect(doItem.every((i) => i.severidade === "ERRO")).toBe(true);
    const e = await erroDe(uc.contextoEmissao("tenant", "dev-dls"));
    expect(e.code).toBe("DEVOLUCAO_INVALIDA");
  });

  it("um valor NOVO continua julgado: trocar a alíquota do 01 gravado (1,65 → 2) é recusado, com a peça", async () => {
    const { salvar, chamadas } = montar({ tributacaoSalva: { 6: tributacaoGravadaPis01() } });
    const e = await erroDe(salvar([{ nItem: 5 }, { nItem: 6, tributacao: { pis: { cst: "01", p: 2 } } }]));
    expect(e.code).toBe("TRIBUTACAO_NAO_SUPORTADA");
    expect(e.issues).toHaveLength(1);
    expect(e.issues[0]).toMatchObject({ code: "PIS_COFINS_REGIME_INCOMPATIVEL", ordem: 2, nItem: 6, chaveAcesso: CHAVE_DISAUTO });
    expect(chamadas.gravados).toHaveLength(0);
  });

  it("sem nada gravado por ela (derivação), mandar o 01 continua recusado — o salvo não é a base", async () => {
    const { salvar } = montar();
    const e = await erroDe(salvar([{ nItem: 6, tributacao: { pis: { cst: "01", p: 1.65 } } }]));
    expect(e.issues[0]).toMatchObject({ code: "PIS_COFINS_REGIME_INCOMPATIVEL", nItem: 6, chaveAcesso: CHAVE_DISAUTO });
  });
});

// ─────────────────────── recusas do PUT dos itens: a PEÇA ───────────────────────

describe("revisão de regressão (G2 #2): toda recusa do PUT dos itens diz a PEÇA — nItem e chave, além da ordem", () => {
  it("tributação, saldo e CFOP de itens diferentes: cada issue com o nItem e a chave DELA", async () => {
    const { salvar } = montar({ linhas: [linha(5, 1, "AUTHORIZED")] });
    const e = await erroDe(salvar([{ nItem: 5 }, { nItem: 6, tributacao: { pis: { cst: "01", p: 1.65 } } }]));
    expect(e.issues.map((i: any) => [i.code, i.ordem, i.nItem, i.chaveAcesso])).toEqual([
      ["SALDO_EXCEDIDO", 1, 5, CHAVE_DISAUTO],
      ["PIS_COFINS_REGIME_INCOMPATIVEL", 2, 6, CHAVE_DISAUTO],
    ]);
  });
});

// ─────────────────────────── K11: itens fora da devolução ───────────────────────────

describe("K11 (G3→G2 #1): o detalhe traz as peças da nota original FORA da devolução, para voltarem depois de recarregar", () => {
  it("item 5 tirado (só o 6 gravado): vem em itensForaDaDevolucao, com a quantidade que voltaria e o CFOP sugerido", async () => {
    const { uc } = montar({ salvos: [6] });
    const d = await uc.detalhe("tenant", "dev-dls");
    expect(d.itens.map((i) => i.nItem)).toEqual([6]);
    expect(d.itensForaDaDevolucao).toHaveLength(1);
    const fora = d.itensForaDaDevolucao![0];
    expect(fora).toMatchObject({
      ordem: 0, chaveAcesso: CHAVE_DISAUTO, nItem: 5, codigo: "33603-3", descricao: "PECA 33603-3", unidade: "UN", ncm: "84133090",
      quantidadeOriginal: 1, devolvidaAutorizada: 0, emProcessamento: 0, emRascunho: 0, disponivel: 1, quantidade: 1, valorUnitario: 123.56, valor: 123.56,
      cfopOriginal: "5102", outrasDevolucoes: [],
    });
    // CFOP: o SUGERIDO. Da venda 5102 do fornecedor não há um só (a finalidade da entrada
    // é dela): vazio, com as opções — o mesmo que a devolução nova mostra.
    expect(fora.cfop).toBe("");
    expect(fora.cfopStatus).toBe("ESCOLHA");
    expect(fora.cfopOpcoes).toContain("5202");
    // A tributação de PARTIDA (a mesma que o PUT recalcula ao voltar) e a referência da nota do fornecedor.
    expect(fora.tributacao.fonte).toBe("XML_ORIGINAL");
    expect(fora.referenciaOriginal?.frases.icms).toMatch(/^Na nota do fornecedor: CST 00 · base R\$ 123,56/);
  });

  it("peça SEM saldo (já devolvida em NF-e autorizada) não volta: fica fora da lista", async () => {
    const { uc } = montar({ salvos: [6], linhas: [linha(5, 1, "AUTHORIZED")] });
    const d = await uc.detalhe("tenant", "dev-dls");
    expect(d.itensForaDaDevolucao).toEqual([]);
  });

  it("parte já devolvida: volta com o que SOBROU, e diz onde está o resto", async () => {
    const { uc } = montar({ itens: [{ ...ITEM5, qCom: 3 }, ITEM6], salvos: [6], linhas: [linha(5, 1, "AUTHORIZED", { devolucaoNfeId: "dev-715", numeroDevolucao: 715, serieDevolucao: 1 })] });
    const d = await uc.detalhe("tenant", "dev-dls");
    const fora = d.itensForaDaDevolucao![0];
    expect(fora).toMatchObject({ nItem: 5, quantidadeOriginal: 3, devolvidaAutorizada: 1, disponivel: 2, quantidade: 2 });
    expect(fora.outrasDevolucoes).toEqual([{ nfeId: "dev-715", status: "AUTHORIZED", numero: 715, serie: 1, quantidade: 1, criadaEm: null }]);
  });

  it("pela chave (sem quantidade da nota): volta com quantidade 0 — ela digita —, sem imposto original", async () => {
    const { uc } = montar({ fonte: "MANUAL", salvos: [6] });
    const d = await uc.detalhe("tenant", "dev-dls");
    const fora = d.itensForaDaDevolucao![0];
    expect(fora).toMatchObject({ nItem: 5, disponivel: null, quantidade: 0, valor: 0, referenciaOriginal: null });
  });

  it("todas as peças na devolução: lista vazia", async () => {
    const { uc } = montar();
    expect((await uc.detalhe("tenant", "dev-dls")).itensForaDaDevolucao).toEqual([]);
  });
});

// ─────────────────────────── criar(): escopo derivado ───────────────────────────

describe("revisão de regressão (G2 #1): criar() grava o escopo DERIVADO das quantidades", () => {
  // A venda autorizada (a "original") emitida pela própria empresa: o XML da fixture com o
  // CNPJ da config igual ao do emitente.
  const XML_VENDA = xmlCompraDisauto([{ ...ITENS_DISAUTO[4] }, { ...ITENS_DISAUTO[5] }]);
  function montarCriar(linhas: ReturnType<typeof linha>[] = []) {
    const original = {
      id: "orig", userId: "tenant", companyFiscalConfigId: CFC, status: "AUTHORIZED", tipoOperacao: "SAIDA", finalidade: "NORMAL", modelo: "55",
      ambiente: "HOMOLOGACAO", chaveAcesso: CHAVE_DISAUTO, xmlAutorizadoPath: "fiscal/orig.xml", destinatarioJson: { tipoPessoa: "PJ", cpfCnpj: CNPJ_DLS, nome: "DLS", uf: "SC" },
      customerId: null, dataEmissao: new Date("2026-09-10T13:00:00Z"), itens: [],
    };
    const { repo, chamadas } = repoEmMemoria({ persistidas: { orig: { nota: original } }, linhas });
    const configs = { findByIdForUser: async () => configDls({ cnpj: CNPJ_DISAUTO }), findByUserId: async () => configDls({ cnpj: CNPJ_DISAUTO }) };
    const storage = { readFile: async () => Buffer.from(XML_VENDA, "utf8") };
    return { uc: new NfeDevolucaoUseCase(repo as never, configs as never, storage as never), chamadas };
  }

  it("'Devolver parcial' numa nota sem devolução nasce com TODAS as peças cheias: grava TOTAL (antes: o pedido, PARCIAL)", async () => {
    const { uc, chamadas } = montarCriar();
    const r = await uc.criar("tenant", "tenant", "orig", { escopo: "PARCIAL" });
    expect(chamadas.criados[0].escopo).toBe("TOTAL");
    expect(r).toEqual({ draftId: "novo-rascunho", reutilizado: false, escopo: "TOTAL" });
  });

  it("nota com parte já devolvida: 'Devolver parcial' grava PARCIAL; 'Devolver total' continua recusado", async () => {
    const parcial = montarCriar([linha(5, 1, "AUTHORIZED", { chave: CHAVE_DISAUTO })]);
    await parcial.uc.criar("tenant", "tenant", "orig", { escopo: "PARCIAL" });
    expect(parcial.chamadas.criados[0].escopo).toBe("PARCIAL");
    expect(parcial.chamadas.criados[0].refs.map((r: any) => r.nItemOriginal)).toEqual([6]);

    const total = montarCriar([linha(5, 1, "AUTHORIZED", { chave: CHAVE_DISAUTO })]);
    const e = await erroDe(total.uc.criar("tenant", "tenant", "orig", { escopo: "TOTAL" }));
    expect(e.code).toBe("PARCIALMENTE_DEVOLVIDA");
    expect(total.chamadas.criados).toHaveLength(0);
  });
});

// ─────────────── K6(3): pela chave, nota do Dexo com XML guardado ───────────────

describe("K6(3): devolução de venda pela CHAVE de uma nota do Dexo que tem o XML guardado é recusada", () => {
  const itemDigitado = { nItem: 2, codigo: "PECA-2", descricao: "PECA", ncm: "84133090", cest: null, unidade: "UN", origem: null, cfopOriginal: "5102", cfop: null, quantidadeOriginal: null, valorUnitario: 10, quantidade: 1 };
  const venda = (): ManualValidado => ({
    modo: "CHAVE", tipo: "VENDA_ENTRADA", companyFiscalConfigId: CFC, devolvidaAposEntrega: null, escopo: null, chaveAcesso: chave(CNPJ_DLS, 713), confirmarSemXml: true,
    destinatario: { tipoPessoa: "PJ", cpfCnpj: "11222333000181", nome: "CLIENTE", uf: "SC" }, itens: [itemDigitado],
  } as ManualValidado);
  const comXml = { id: "orig-713", xmlAutorizadoPath: "fiscal/tenant/xml/713.xml", itens: [{ numero: 2, codigo: "PECA-2", quantidade: "4" }] };

  it("criar: 409 ORIGINAL_TEM_XML_NO_DEXO com o caminho certo, e nada é criado nem reaproveitado", async () => {
    const { repo, chamadas } = repoEmMemoria({ notaPorChave: comXml, aberta: "rascunho-velho" });
    const e = await erroDe(casoDeUso(repo).manual("tenant", "tenant", venda()));
    expect(e.code).toBe("ORIGINAL_TEM_XML_NO_DEXO");
    expect(e.httpStatus).toBe(409);
    expect(e.message).toContain("Devolver");
    expect(chamadas.criados).toHaveLength(0);
  });

  it("prévia: a mesma recusa", async () => {
    const { repo } = repoEmMemoria({ notaPorChave: comXml });
    const e = await erroDe(casoDeUso(repo).previaManual("tenant", venda()));
    expect(e.code).toBe("ORIGINAL_TEM_XML_NO_DEXO");
  });

  it("CONTROLE: a mesma nota SEM XML guardado (histórico importado) continua indo pela chave", async () => {
    const { repo, chamadas } = repoEmMemoria({ notaPorChave: { ...comXml, xmlAutorizadoPath: null } });
    await casoDeUso(repo).manual("tenant", "tenant", venda());
    expect(chamadas.criados).toHaveLength(1);
  });

  it("CONTROLE: devolução de COMPRA pela chave não consulta nota do Dexo (a nota é do fornecedor)", async () => {
    const { repo, chamadas } = repoEmMemoria({ notaPorChave: comXml });
    await casoDeUso(repo).manual("tenant", "tenant", {
      ...venda(), tipo: "COMPRA_SAIDA", chaveAcesso: CHAVE_DISAUTO,
      destinatario: { tipoPessoa: "PJ", cpfCnpj: CNPJ_DISAUTO, nome: "DISAUTO", uf: null },
    } as ManualValidado);
    expect(chamadas.criados).toHaveLength(1);
  });
});

// ──────────────── /abertas e /disponibilidade sem ir ao banco à toa ────────────────

/** Repositório que CONTA as consultas de configs/rascunhos. */
function repoContado(o: { empresas?: Array<Record<string, unknown>>; donos?: (ids: string[]) => string[] } = {}) {
  const { repo } = repoEmMemoria();
  const consultas: string[] = [];
  Object.assign(repo, {
    donosDasConfigs: async (ids: string[]) => { consultas.push("donos:" + ids.join(",")); return (o.donos ?? ((x: string[]) => (x.includes(CFC) ? ["tenant"] : [])))(ids); },
    configsDoUsuario: async () => { consultas.push("configs"); return (o.empresas ?? [{ id: CFC, isDefault: true }]).map((e) => ({ id: e.id, isDefault: e.isDefault })); },
    empresasDoUsuario: async () => { consultas.push("empresas"); return o.empresas ?? [{ id: CFC, isDefault: true, cnpj: CNPJ_DLS, razaoSocial: "DLS AUTO PECAS", nomeFantasia: null, uf: "SC", ambiente: "HOMOLOGACAO" }]; },
    abertasDoUsuario: async () => { consultas.push("abertas"); return []; },
    reservasVivas: async () => { consultas.push("reservas"); return []; },
  });
  return { uc: casoDeUso(repo), consultas };
}

describe("/abertas sem a devolução ligada: 200 com lista vazia e SEM consulta por requisição (revisão de regressão)", () => {
  it("devolução desligada na env: lista vazia sem NENHUMA consulta", async () => {
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    const { uc, consultas } = repoContado();
    expect(await uc.abertas("tenant")).toEqual({ abertas: [] });
    expect(consultas).toEqual([]);
  });

  it("cliente que não é dono de nenhuma config da allowlist: lista vazia; os donos são lidos UMA vez e as cargas seguintes não consultam nada", async () => {
    const { uc, consultas } = repoContado();
    expect(await uc.abertas("outro-cliente")).toEqual({ abertas: [] });
    expect(await uc.abertas("outro-cliente")).toEqual({ abertas: [] });
    expect(await uc.abertas("mais-um")).toEqual({ abertas: [] });
    expect(consultas).toEqual([`donos:${CFC}`]);
  });

  it("a DLS (dona da config ligada) continua passando pela regra de sempre", async () => {
    const { uc, consultas } = repoContado();
    expect(await uc.abertas("tenant")).toEqual({ abertas: [] });
    expect(consultas).toEqual([`donos:${CFC}`, "configs", "abertas", "reservas"]);
  });

  it("allowlist '*' (todos podem ter): sem atalho — decide a consulta das configs do usuário", async () => {
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", "*");
    const { uc, consultas } = repoContado();
    await uc.abertas("tenant");
    expect(consultas[0]).toBe("configs");
    expect(consultas.some((c) => c.startsWith("donos"))).toBe(false);
  });

  it("id na allowlist da devolução mas FORA da numeração V2: não conta como ligada (a regra é isDevolucaoAtiva) — nenhuma consulta", async () => {
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", "cfg-sem-v2");
    const { uc, consultas } = repoContado();
    expect(await uc.abertas("tenant")).toEqual({ abertas: [] });
    expect(consultas).toEqual([]);
  });
});

describe("G4 #3 (K12): /disponibilidade lista TODAS as empresas com a devolução ligada; o campo de sempre continua", () => {
  const empresa = (id: string, isDefault: boolean, cnpj: string) => ({ id, isDefault, cnpj, razaoSocial: "EMPRESA " + id, nomeFantasia: null, uf: "SC", ambiente: "PRODUCAO" });

  it("a padrão ligada: o de antes (disponivel + companyFiscalConfigId da padrão), mais `empresas`", async () => {
    const { uc } = repoContado({ empresas: [empresa(CFC, true, CNPJ_DLS), empresa("cfg-2", false, "11111111000191")] });
    expect(await uc.disponibilidade("tenant")).toEqual({
      disponivel: true, companyFiscalConfigId: CFC,
      empresas: [{ companyFiscalConfigId: CFC, cnpj: CNPJ_DLS, razaoSocial: "EMPRESA " + CFC, nomeFantasia: null, uf: "SC", ambiente: "PRODUCAO", isDefault: true }],
    });
  });

  it("duas empresas ligadas: as duas em `empresas`, a padrão primeiro e no campo de sempre", async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", `${CFC},cfg-2`);
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", `${CFC},cfg-2`);
    const { uc } = repoContado({ empresas: [empresa(CFC, true, CNPJ_DLS), empresa("cfg-2", false, "11111111000191")], donos: () => ["tenant"] });
    const r = await uc.disponibilidade("tenant");
    expect(r.companyFiscalConfigId).toBe(CFC);
    expect(r.empresas.map((e) => [e.companyFiscalConfigId, e.isDefault])).toEqual([[CFC, true], ["cfg-2", false]]);
  });

  it("a padrão DESLIGADA e uma outra ligada: antes 404 (a tela manual ficava sem empresa); agora a ligada", async () => {
    const { uc } = repoContado({ empresas: [empresa("cfg-padrao", true, "22222222000191"), empresa(CFC, false, CNPJ_DLS)] });
    const r = await uc.disponibilidade("tenant");
    expect(r.companyFiscalConfigId).toBe(CFC);
    expect(r.empresas.map((e) => e.companyFiscalConfigId)).toEqual([CFC]);
  });

  it("a padrão desligada e DUAS ligadas: o campo de sempre fica null (a tela escolhe em `empresas`) — nunca um CNPJ escolhido por ela", async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", `${CFC},cfg-2`);
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", `${CFC},cfg-2`);
    const { uc } = repoContado({ empresas: [empresa("cfg-padrao", true, "22222222000191"), empresa(CFC, false, CNPJ_DLS), empresa("cfg-2", false, "11111111000191")], donos: () => ["tenant"] });
    const r = await uc.disponibilidade("tenant");
    expect(r.companyFiscalConfigId).toBeNull();
    expect(r.empresas.map((e) => e.companyFiscalConfigId)).toEqual([CFC, "cfg-2"]);
  });

  it("nenhuma ligada: 404 'Recurso indisponível' — e quem não é dono de config ligada nem chega a consultar as empresas", async () => {
    const semLigada = repoContado({ empresas: [empresa("cfg-padrao", true, "22222222000191")] });
    const e = await erroDe(semLigada.uc.disponibilidade("tenant"));
    expect([e.httpStatus, e.message]).toEqual([404, "Recurso indisponível"]);

    const outro = repoContado();
    const e2 = await erroDe(outro.uc.disponibilidade("outro-cliente"));
    expect(e2.httpStatus).toBe(404);
    expect(outro.consultas).toEqual([`donos:${CFC}`]);
  });
});

// ─────── G4 #4: o saldo não depende de registrarAutorizacao (conferido) ───────

describe("G4 #4: o SALDO sai do status da nota de devolução, não dos eventos de registrarAutorizacao", () => {
  it("linhasSaldo lê NfeEmitida.status da devolução (o commit da autorização) — nenhum evento de auditoria", async () => {
    const sqls: string[] = [];
    const db = { $queryRawUnsafe: async (sql: string) => { sqls.push(sql); return []; } };
    await new NfeDevolucaoRepository(db as never).linhasSaldo("tenant", CHAVE_DISAUTO);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain(`n."status" AS "statusDevolucao"`);
    expect(sqls[0]).toContain(`JOIN "NfeEmitida" n ON n."id"=d."devolucaoNfeId"`);
    expect(sqls[0]).not.toContain("NfeAuditLog");
  });

  it("devolução AUTORIZADA sem NENHUM evento DEVOLUCAO_AUTORIZADA: a peça já não tem saldo e a original não pode ser cancelada", async () => {
    const { repo } = repoEmMemoria({ persistidas: { "dev-dls": persistida({ salvos: [6] }) }, linhas: [linha(5, 1, "AUTHORIZED")], eventos: [] });
    let consultouEvento = false;
    Object.assign(repo, { temEvento: async () => { consultouEvento = true; return false; } });
    const d = await casoDeUso(repo).detalhe("tenant", "dev-dls");
    // O item 5 foi devolvido por OUTRA devolução, autorizada: não sobra saldo (não volta).
    expect(d.itensForaDaDevolucao).toEqual([]);
    expect(d.itens.map((i) => [i.nItem, i.disponivel])).toEqual([[6, 1]]);
    expect(consultouEvento).toBe(false);
    expect(erroOriginalComDevolucao([linha(5, 1, "AUTHORIZED")])?.code).toBe("ORIGINAL_COM_DEVOLUCAO");
  });
});

// ─────────── G4 #4: cancelar a original cita a devolução que impede ───────────

describe("G4 #4: ORIGINAL_COM_DEVOLUCAO cita CADA devolução — nº e id", () => {
  it("devolução autorizada nº 715: a frase diz o número e a issue traz o id", () => {
    const e = erroOriginalComDevolucao([
      linha(5, 1, "AUTHORIZED", { devolucaoNfeId: "dev-715", numeroDevolucao: 715, serieDevolucao: 1 }),
      linha(6, 1, "AUTHORIZED", { devolucaoNfeId: "dev-715", numeroDevolucao: 715, serieDevolucao: 1 }),
    ])!;
    expect(e.code).toBe("ORIGINAL_COM_DEVOLUCAO");
    expect(e.httpStatus).toBe(409);
    expect(e.message).toContain("nº 715 (série 1) autorizada");
    expect(e.issues).toEqual([{
      code: "PARCIALMENTE_DEVOLVIDA", severidade: "ERRO", devolucaoNfeId: "dev-715", numeroDevolucao: 715, serieDevolucao: 1,
      mensagem: 'Esta nota tem a NF-e de devolução nº 715 (série 1) autorizada. Cancele primeiro a devolução (em "Notas Emitidas") e depois esta nota.',
    }]);
  });

  it("devolução em envio (sem nº fiscal ainda): diz que está sendo enviada, com o id", () => {
    const e = erroOriginalComDevolucao([linha(5, 1, "SENDING", { devolucaoNfeId: "dev-x", numeroDevolucao: -3, serieDevolucao: 1 })])!;
    expect(e.issues).toEqual([expect.objectContaining({ code: "EMISSAO_EM_ANDAMENTO", devolucaoNfeId: "dev-x", numeroDevolucao: null })]);
    expect(e.message).toContain("sendo enviada à SEFAZ");
  });

  it("a MESMA regra de antes: rascunho, rejeitada e cancelada não impedem", () => {
    expect(erroOriginalComDevolucao([linha(5, 1, "DRAFT"), linha(5, 1, "REJECTED"), linha(6, 1, "CANCELLED"), linha(6, 1, "INUTILIZED")])).toBeNull();
    expect(erroOriginalComDevolucao([])).toBeNull();
    for (const status of ["AUTHORIZED", "VALIDATING", "SIGNING", "SENDING"]) {
      expect(erroOriginalComDevolucao([linha(5, 1, status)])?.code).toBe("ORIGINAL_COM_DEVOLUCAO");
    }
  });
});
