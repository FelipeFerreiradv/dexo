import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { makeConfig } from "../../__helpers__/test-draft";
import { calcularDvChaveAcesso } from "../../../../app/fiscal/domain/chave-acesso-dv";

// Devolução de COMPRA ponta a ponta com PostgreSQL REAL (achado N-completude-2, parte 2;
// pendência G6 #1 da auditoria da devolução).
//
// tests/fiscal/devolucao/devolucao-compra-ponta-a-ponta.spec.ts percorre o mesmo caminho da
// DLS AUTO PEÇAS (Simples, SC) devolvendo à DISAUTO (regime normal, SC) os itens 5 e 6 da
// NF-e 852899, mas com o SQL respondido em memória: não prova que o SQL do repositório bate
// com o schema e os DDLs reais. Aqui o banco é o de verdade — schema do Prisma (gerado sem
// contato com banco, `prisma migrate diff --from-empty`), DDLs de 18/09 (numeração V2 e
// devolução, com as FKs ON DELETE CASCADE e os CHECKs) e os índices parciais de produção:
//  - nomes e tipos de coluna (numeric com escala, jsonb ida e volta, boolean, NOT NULL);
//  - o lock da chave (pg_advisory_xact_lock) contra o clique duplo;
//  - o reaproveitamento do rascunho aberto (JOIN com o cabeçalho, filtro por status e tipo);
//  - itens() salvando um tributo só (DELETE + INSERT das peças; a recusa não grava nada);
//  - o escopo derivado gravado pelo UPDATE com COALESCE($3, …) e o CHECK do DDL;
//  - o descarte: DELETE da nota e o CASCADE para NfeDevolucao, NfeDevolucaoItem, NfeItem e
//    NfeAuditLog, pelos dois caminhos do DELETE /nfe/draft/:id (numeração V2 e Prisma);
//  - a emissão pelo orquestrador V2 (claim, reserva, validarReserva na transação,
//    registrarAutorizacao) e o saldo do livro depois da nota AUTORIZADA.
//
// Diferença para o harness (tests/fiscal/__harness__/pg-nfe-schema.ts): ele deixa de fora as
// tabelas da devolução e TODAS as FKs do schema do Prisma. Aqui entram o DDL da devolução
// (como em regressao/devolucao-1) e, do próprio `migrate diff`, as duas FKs que o descarte
// usa em produção: NfeItem.nfeId e NfeAuditLog.nfeId → NfeEmitida ON DELETE CASCADE.
//
// Reais: NfeDevolucaoRepository, NfeDevolucaoUseCase, os parsers da rota (contrato.ts),
// NfeDraftUseCase.delete, NfeRepository, a numeração V2 (serviço + repositório),
// NfeEmissaoV2Orchestrator, calcularDevolucao e o NfeXmlBuilderSefazService.
// Simulados: o transporte SEFAZ (a assinatura e o envio; o XML é o do builder real), o
// repositório de CompanyFiscalConfig (mapa — a tabela existe e tem a linha, para as
// consultas de "Devoluções em andamento") e o responsável técnico.
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_dev_compra_${randomUUID().replace(/-/g, "")}`;

const h = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  /** XML que o builder REAL montou em cada prepararEmissao (sem assinatura). */
  xmls: [] as string[],
  /** Números transmitidos à SEFAZ (simulada). */
  transmitidas: [] as number[],
  /** cStat do protocolo que a SEFAZ simulada devolve. */
  cStat: 100,
}));

vi.mock("../../../../app/fiscal/providers/sefaz-direct.provider", async () => {
  const { NfeXmlBuilderSefazService } = await import("../../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service");
  class SefazDirectProvider {
    static montarNfeProc() { return "<nfeProc/>"; }
    // O prepararEmissao de verdade monta com o MESMO builder e depois assina com o A1; aqui
    // só a assinatura fica de fora (o "signedXml" é o XML montado).
    prepararEmissao(p: { draft: never; config: never; numero: number; cNF: string; dhEmi: Date; respTec?: unknown; devolucao?: unknown }) {
      const built = new NfeXmlBuilderSefazService().build({
        draft: p.draft, config: p.config, numero: p.numero, dhEmi: p.dhEmi, cNF: p.cNF, tpEmis: 1,
        respTec: (p.respTec ?? undefined) as never, ...(p.devolucao ? { devolucao: p.devolucao as never } : {}),
      });
      h.xmls.push(built.xml);
      return { numero: p.numero, cNF: p.cNF, dhEmi: p.dhEmi, chaveAcesso: built.chaveAcesso, signedXml: built.xml, digestValue: "digest", modelo: "55", tpEmis: 1 };
    }
    async transmitirPreparada(p: { numero: number; chaveAcesso: string }) {
      h.transmitidas.push(p.numero);
      const ok = h.cStat === 100;
      return { transporte: null, httpStatus: 200, loteCStat: 104, loteXMotivo: "Lote processado", protCStat: h.cStat,
        protXMotivo: ok ? "Autorizado o uso da NF-e" : "Rejeicao: campo invalido", nProt: ok ? "342260000000716" : null,
        dhRecbto: new Date(), nRec: null, chNFe: p.chaveAcesso, protNFeXml: null, xmlAutorizado: ok ? "<nfeProc/>" : null };
    }
  }
  return { SefazDirectProvider };
});
vi.mock("../../../../app/fiscal/providers/provider-factory", async () => {
  const { SefazDirectProvider } = await import("../../../../app/fiscal/providers/sefaz-direct.provider");
  return {
    createNfeProviderFromConfig: async () => new (SefazDirectProvider as unknown as new () => unknown)(),
    // A devolução de compra pelo XML nunca busca XML na Focus.
    createNfeProvider: () => { throw new Error("createNfeProvider não deveria ser chamado"); },
  };
});
vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string, userId: string) => { const c = h.configs.get(id) as { userId: string } | undefined; return c && c.userId === userId ? c : null; };
    findByUserId = async (userId: string) => [...h.configs.values()].find((c) => (c as { userId: string; isDefault: boolean }).userId === userId && (c as { isDefault: boolean }).isDefault) ?? null;
  },
}));
vi.mock("../../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({ resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }) }));

// ─────────────────────────── a DLS e a nota de compra da DISAUTO ───────────────────────────

const USER = "tenant-dls";
const ATOR = "dona-da-dls";
const CFC = "cfg-dls";
const CNPJ_DLS = "57502966000144";
const CNPJ_DISAUTO = "80689839000975";
/** O nº que a sequência da DLS entrega à próxima NF-e (seed de cada caso). */
const PROXIMO_NUMERO = 716;

function chave(cnpj: string, numero: number, cUF = "42"): string {
  const base = cUF + "2609" + cnpj + "55" + "001" + String(numero).padStart(9, "0") + "1" + "75799182";
  return base + calcularDvChaveAcesso(base)!;
}
const CHAVE_DISAUTO = chave(CNPJ_DISAUTO, 852899);

const r2 = (x: number) => Math.round(x * 100 + 1e-9) / 100;
const f2 = (x: number) => x.toFixed(2);

interface ItemCompra {
  nItem: number; cProd: string; xProd: string; ncm: string; cfop: string; qCom: number; vUnCom: number;
  icms: { cst: "00" | "10"; vBC: number; vICMS: number; st?: { pMVAST: number; vBCST: number; pICMSST: number; vICMSST: number } };
  pisCofins: "01" | "04";
  vBCPis?: number;
}
// Os mesmos 6 itens do teste em memória (item 1 com ST, 5 e 6 os devolvidos pela DLS).
const NOTA_DISAUTO: ItemCompra[] = [
  { nItem: 1, cProd: "11111-1", xProd: "OLEO LUBRAX 5W30 1L", ncm: "27101932", cfop: "5403", qCom: 3, vUnCom: 39.15,
    icms: { cst: "10", vBC: 117.45, vICMS: 14.09, st: { pMVAST: 71.03, vBCST: 200.87, pICMSST: 17, vICMSST: 20.05 } }, pisCofins: "04" },
  { nItem: 2, cProd: "22222-2", xProd: "FILTRO DE AR", ncm: "84213100", cfop: "5102", qCom: 2, vUnCom: 30, icms: { cst: "00", vBC: 60, vICMS: 7.2 }, pisCofins: "01", vBCPis: 52.8 },
  { nItem: 3, cProd: "33333-3", xProd: "CORREIA DENTADA", ncm: "40103900", cfop: "5102", qCom: 1, vUnCom: 50, icms: { cst: "00", vBC: 50, vICMS: 6 }, pisCofins: "01", vBCPis: 44 },
  { nItem: 4, cProd: "44444-4", xProd: "VELA DE IGNICAO", ncm: "85111000", cfop: "5102", qCom: 4, vUnCom: 20, icms: { cst: "00", vBC: 80, vICMS: 9.6 }, pisCofins: "01", vBCPis: 70.4 },
  { nItem: 5, cProd: "33603-3", xProd: "BOMBA DAGUA", ncm: "84133090", cfop: "5102", qCom: 1, vUnCom: 123.56, icms: { cst: "00", vBC: 123.56, vICMS: 14.83 }, pisCofins: "01", vBCPis: 108.73 },
  { nItem: 6, cProd: "24171-7", xProd: "10255 SCHADEK BOMBA OLEO", ncm: "84133090", cfop: "5102", qCom: 1, vUnCom: 295.88, icms: { cst: "00", vBC: 295.88, vICMS: 35.51 }, pisCofins: "04" },
];
const vProdDe = (i: ItemCompra) => r2(i.qCom * i.vUnCom);
const vPisDe = (i: ItemCompra) => (i.pisCofins === "01" ? r2((i.vBCPis ?? 0) * 0.0165) : 0);
const vCofinsDe = (i: ItemCompra) => (i.pisCofins === "01" ? r2((i.vBCPis ?? 0) * 0.076) : 0);

/** O procNFe autorizado da compra (DISAUTO → DLS, produção), com os totais fechando. */
function xmlDaCompra(itens: ItemCompra[], nNF: number): string {
  const ch = chave(CNPJ_DISAUTO, nNF);
  const det = itens.map((i) => {
    const s = i.icms.st;
    const icms = i.icms.cst === "10" && s
      ? `<ICMS10><orig>0</orig><CST>10</CST><modBC>3</modBC><vBC>${f2(i.icms.vBC)}</vBC><pICMS>12.00</pICMS><vICMS>${f2(i.icms.vICMS)}</vICMS>` +
        `<modBCST>4</modBCST><pMVAST>${f2(s.pMVAST)}</pMVAST><vBCST>${f2(s.vBCST)}</vBCST><pICMSST>${f2(s.pICMSST)}</pICMSST><vICMSST>${f2(s.vICMSST)}</vICMSST></ICMS10>`
      : `<ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>${f2(i.icms.vBC)}</vBC><pICMS>12.00</pICMS><vICMS>${f2(i.icms.vICMS)}</vICMS></ICMS00>`;
    const pisCofins = i.pisCofins === "01"
      ? `<PIS><PISAliq><CST>01</CST><vBC>${f2(i.vBCPis ?? 0)}</vBC><pPIS>1.65</pPIS><vPIS>${f2(vPisDe(i))}</vPIS></PISAliq></PIS>` +
        `<COFINS><COFINSAliq><CST>01</CST><vBC>${f2(i.vBCPis ?? 0)}</vBC><pCOFINS>7.60</pCOFINS><vCOFINS>${f2(vCofinsDe(i))}</vCOFINS></COFINSAliq></COFINS>`
      : `<PIS><PISNT><CST>04</CST></PISNT></PIS><COFINS><COFINSNT><CST>04</CST></COFINSNT></COFINS>`;
    return `<det nItem="${i.nItem}"><prod><cProd>${i.cProd}</cProd><cEAN>SEM GTIN</cEAN><xProd>${i.xProd}</xProd><NCM>${i.ncm}</NCM><CFOP>${i.cfop}</CFOP>` +
      `<uCom>UN</uCom><qCom>${i.qCom.toFixed(4)}</qCom><vUnCom>${i.vUnCom.toFixed(10)}</vUnCom><vProd>${f2(vProdDe(i))}</vProd>` +
      `<cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>${i.qCom.toFixed(4)}</qTrib><vUnTrib>${i.vUnCom.toFixed(10)}</vUnTrib><indTot>1</indTot></prod>` +
      `<imposto><ICMS>${icms}</ICMS>${pisCofins}</imposto></det>`;
  }).join("");
  const soma = (fn: (i: ItemCompra) => number) => r2(itens.reduce((n, i) => n + fn(i), 0));
  const vProd = soma(vProdDe);
  const vST = soma((i) => i.icms.st?.vICMSST ?? 0);
  const vNF = r2(vProd + vST);
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${ch}" versao="4.00">` +
    `<ide><cUF>42</cUF><cNF>${ch.slice(35, 43)}</cNF><natOp>VENDA DE MERCADORIA</natOp><mod>55</mod><serie>1</serie><nNF>${nNF}</nNF><dhEmi>2026-09-10T10:00:00-03:00</dhEmi>` +
    `<tpNF>1</tpNF><idDest>1</idDest><cMunFG>4209102</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>${ch.slice(-1)}</cDV><tpAmb>1</tpAmb><finNFe>1</finNFe>` +
    `<indFinal>0</indFinal><indPres>9</indPres><procEmi>0</procEmi><verProc>ERP-FORNECEDOR</verProc></ide>` +
    `<emit><CNPJ>${CNPJ_DISAUTO}</CNPJ><xNome>DISAUTO DISTRIBUIDORA DE AUTOPECAS LTDA</xNome><enderEmit><xLgr>RUA DO FORNECEDOR</xLgr><nro>1000</nro><xBairro>DISTRITO INDUSTRIAL</xBairro>` +
    `<cMun>4209102</cMun><xMun>JOINVILLE</xMun><UF>SC</UF><CEP>89219500</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderEmit><IE>258272414</IE><CRT>3</CRT></emit>` +
    `<dest><CNPJ>${CNPJ_DLS}</CNPJ><xNome>DLS AUTO PECAS LTDA</xNome><enderDest><xLgr>RUA DAS PECAS</xLgr><nro>200</nro><xBairro>CENTRO</xBairro><cMun>4209102</cMun>` +
    `<xMun>JOINVILLE</xMun><UF>SC</UF><CEP>89201000</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderDest><indIEDest>1</indIEDest><IE>261234567</IE></dest>` +
    det +
    `<total><ICMSTot><vBC>${f2(soma((i) => i.icms.vBC))}</vBC><vICMS>${f2(soma((i) => i.icms.vICMS))}</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP>` +
    `<vBCST>${f2(soma((i) => i.icms.st?.vBCST ?? 0))}</vBCST><vST>${f2(vST)}</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${f2(vProd)}</vProd>` +
    `<vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>${f2(soma(vPisDe))}</vPIS>` +
    `<vCOFINS>${f2(soma(vCofinsDe))}</vCOFINS><vOutro>0.00</vOutro><vNF>${f2(vNF)}</vNF></ICMSTot></total>` +
    `<transp><modFrete>0</modFrete></transp><pag><detPag><tPag>15</tPag><vPag>${f2(vNF)}</vPag></detPag></pag></infNFe></NFe>` +
    `<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><verAplic>SVRS202609</verAplic><chNFe>${ch}</chNFe><dhRecbto>2026-09-10T10:00:31-03:00</dhRecbto>` +
    `<nProt>342260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>`;
}
const XML_DISAUTO = xmlDaCompra(NOTA_DISAUTO, 852899);

function configDls() {
  return makeConfig({
    id: CFC, userId: USER, cnpj: CNPJ_DLS, razaoSocial: "DLS AUTO PECAS LTDA", nomeFantasia: "DLS AUTO PECAS", inscricaoEstadual: "261234567",
    regimeTributario: "SIMPLES", ambiente: "PRODUCAO", cep: "89201000", logradouro: "RUA DAS PECAS", numero: "200", bairro: "CENTRO",
    municipio: "JOINVILLE", codMunicipio: "4209102", uf: "SC", providerName: "SEFAZ_DIRECT", serieNfe: 1, isDefault: true,
  } as never);
}

const corpoXml = (xml: string, itens?: Array<{ nItem: number; quantidade: number }>) => ({
  companyFiscalConfigId: CFC, tipo: "COMPRA_SAIDA", xmlOriginal: xml, ...(itens ? { itens } : {}),
});
const ITENS_5_E_6 = [{ nItem: 5, quantidade: 1 }, { nItem: 6, quantidade: 1 }];
/** Um item no corpo do PUT …/devolucao/itens, como a tela monta. */
const item = (nItem: number, extra: Record<string, unknown> = {}) => ({ chaveAcesso: CHAVE_DISAUTO, nItem, quantidade: 1, cfop: "5202", ...extra });
/** O que a tela manda com o CSOSN "900" escolhido e 12% (a alíquota da compra). */
const ICMS_900_DA_COMPRA = { icms: { csosn: "900", cst: null, pICMS: 12 } };
/** O que a tela manda com o PIS/COFINS "49" escolhido (a caixa mostra 0). */
const PIS_COFINS_49 = { pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type No = any;
const lista = (x: No): No[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

async function erroDe(p: Promise<unknown>): Promise<No> {
  try { await p; } catch (e) { return e; }
  throw new Error("esperava a recusa, e a chamada passou");
}

const describePg = describe.skipIf(!raw);
describePg("devolução de COMPRA da DLS (Simples) à DISAUTO, ponta a ponta — PostgreSQL real", () => {
  let admin: PrismaClient;
  let M: No;

  beforeAll(async () => {
    const url = new URL(raw!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("nfe_test")) {
      throw new Error("NFE_TEST_DATABASE_URL deve apontar a banco nfe_test em localhost");
    }
    url.searchParams.set("schema", schema);
    // ANTES de qualquer import da app: o client de app/lib/prisma lê a URL ao ser importado.
    process.env.DATABASE_URL = url.toString();
    process.env.DIRECT_URL = url.toString();
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const diff = execFileSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], { encoding: "utf8", shell: true, env: process.env });
    const doDdl = /"(NfeNumeroReserva|NfeNumeroTentativa|CompanyFiscalRespTec|NfeDevolucao|NfeDevolucaoItem)"/;
    // As FKs do schema do Prisma que o descarte do rascunho usa em produção (o resto das
    // FKs aponta para tabelas que o teste não povoa: User, Order, Customer, Product).
    const fkDoDescarte = /^ALTER TABLE "(NfeItem|NfeAuditLog)" ADD CONSTRAINT "\w+_nfeId_fkey" FOREIGN KEY \("nfeId"\) REFERENCES "NfeEmitida"\("id"\) ON DELETE CASCADE/;
    const stmts = diff.split(/;\s*(?:\r?\n|$)/).map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim())
      .filter((s) => s && (!/FOREIGN KEY/.test(s) || fkDoDescarte.test(s)) && !doDdl.test(s));
    if (stmts.filter((s) => fkDoDescarte.test(s)).length !== 2) throw new Error("o migrate diff não trouxe as FKs NfeItem/NfeAuditLog → NfeEmitida ON DELETE CASCADE");
    for (const sql of stmts) await admin.$executeRawUnsafe(sql);
    await admin.$executeRawUnsafe(`CREATE UNIQUE INDEX "NfeSequence_cfcId_ambiente_serie_modelo_key" ON "NfeSequence"("companyFiscalConfigId","ambiente","serie","modelo") WHERE "companyFiscalConfigId" IS NOT NULL`);
    await admin.$executeRawUnsafe(`CREATE UNIQUE INDEX "NfeEmitida_cfcId_ambiente_serie_numero_modelo_key" ON "NfeEmitida"("companyFiscalConfigId","ambiente","serie","numero","modelo") WHERE "companyFiscalConfigId" IS NOT NULL AND "numero" > 0`);
    for (const arq of ["prisma/ddl/2026-09-18-nfe-numeracao-v2.sql", "prisma/ddl/2026-09-18-nfe-devolucao.sql"]) {
      const ddl = readFileSync(arq, "utf8").replace(/--[^\r\n]*/g, "");
      for (const sql of ddl.split(";").map((s) => s.trim()).filter((s) => s && !["BEGIN", "COMMIT"].includes(s))) await admin.$executeRawUnsafe(sql);
    }
    M = {
      Devolucao: (await import("../../../../app/usecases/nfe-devolucao.usecase")).NfeDevolucaoUseCase,
      DevolucaoRepo: (await import("../../../../app/fiscal/devolucao/devolucao.repository")).NfeDevolucaoRepository,
      contrato: await import("../../../../app/fiscal/devolucao/contrato"),
      NfeDraftUseCase: (await import("../../../../app/usecases/nfe-draft.usecase")).NfeDraftUseCase,
      NfeRepository: (await import("../../../../app/repositories/nfe.repository")).NfeRepository,
      Orchestrator: (await import("../../../../app/usecases/nfe-emissao-v2.orchestrator")).NfeEmissaoV2Orchestrator,
      NfeEmissionUseCase: (await import("../../../../app/usecases/nfe-emission.usecase")).NfeEmissionUseCase,
      prisma: (await import("../../../../app/lib/prisma")).default,
    };
  }, 180000);

  afterAll(async () => {
    if (M?.prisma) await M.prisma.$disconnect();
    if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect(); }
  });

  beforeEach(async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", CFC);
    // Produção antes de 05/10: referência por NOTA (NFref) — o teste não depende do dia.
    vi.stubEnv("NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE", "2099-01-01");
    h.xmls = []; h.transmitidas = []; h.cStat = 100;
    for (const t of ["NfeNumeroTentativa", "NfeNumeroReserva", "NfeSequence", "NfeDevolucaoItem", "NfeDevolucao", "NfeAuditLog", "NfeItem", "NfeEmitida", "CompanyFiscalConfig"]) {
      await admin.$executeRawUnsafe(`DELETE FROM "${t}"`);
    }
    const c = configDls();
    h.configs = new Map([[CFC, c]]);
    await admin.companyFiscalConfig.create({
      data: { id: CFC, userId: USER, isDefault: true, cnpj: CNPJ_DLS, razaoSocial: c.razaoSocial, nomeFantasia: c.nomeFantasia, inscricaoEstadual: c.inscricaoEstadual,
        regimeTributario: "SIMPLES", ambiente: "PRODUCAO", uf: "SC", providerName: "SEFAZ_DIRECT" },
    });
    await admin.$executeRawUnsafe(`INSERT INTO "NfeSequence" ("id","userId","companyFiscalConfigId","ambiente","modelo","serie","proximoNumero","updatedAt") VALUES ($1,$2,$3,'PRODUCAO','55',1,$4,NOW())`, randomUUID(), USER, CFC, PROXIMO_NUMERO);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  // ─────────────────────────── a tela, pelos mesmos parsers da rota ───────────────────────────

  function dls() {
    const uc = new M.Devolucao(undefined, undefined, {} as never);
    const { parseManualBody, parseAtualizarCabecalhoBody, parseAtualizarItensBody } = M.contrato;
    const ok = (p: No) => { if (!p.ok) throw new Error("400 do parser: " + JSON.stringify(p.erros)); return p.value; };
    const tela = {
      previa: (corpo: Record<string, unknown>) => uc.previaManual(USER, ok(parseManualBody(corpo))),
      criar: (corpo: Record<string, unknown>) => uc.manual(USER, ATOR, ok(parseManualBody(corpo))),
      responderEntrega: (id: string, entregue: boolean) => uc.cabecalho(USER, ATOR, id, ok(parseAtualizarCabecalhoBody({ devolvidaAposEntrega: entregue }))),
      salvarItens: (id: string, itens: Array<Record<string, unknown>>) => uc.itens(USER, ATOR, id, ok(parseAtualizarItensBody({ itens }))),
      detalhe: (id: string) => uc.detalhe(USER, id),
    };
    return { uc, tela };
  }

  /**
   * O caminho da DLS no editor (o mesmo do teste em memória): importa o XML, escolhe os itens
   * 5 e 6, responde a entrega e salva cada passo como a tela salva — CFOP, depois o ICMS,
   * depois SÓ o PIS/COFINS com "Revisei".
   */
  async function devolverItens5e6() {
    const d = dls();
    const { draftId: id } = await d.tela.criar(corpoXml(XML_DISAUTO, ITENS_5_E_6));
    await d.tela.responderEntrega(id, true);
    const comCfop = await d.tela.salvarItens(id, [item(5, { confirmarTributacao: false }), item(6, { confirmarTributacao: false })]);
    const comIcms = await d.tela.salvarItens(id, [item(5, { tributacao: ICMS_900_DA_COMPRA }), item(6, { tributacao: ICMS_900_DA_COMPRA })]);
    const final = await d.tela.salvarItens(id, [
      item(5, { tributacao: PIS_COFINS_49, confirmarTributacao: true }),
      item(6, { tributacao: PIS_COFINS_49, confirmarTributacao: true }),
    ]);
    return { ...d, id, comCfop, comIcms, final };
  }

  /** "Emitir" do wizard para uma devolução: o orquestrador V2 com os ganchos da emissão de produção. */
  async function emitir(id: string) {
    const proto = M.NfeEmissionUseCase.prototype;
    const autorizado = vi.fn(async () => ({}) as never);
    const repo = new M.NfeRepository();
    const orq = new M.Orchestrator(
      { validar: (d: unknown, c: unknown) => proto.validate.call(proto, d, c), snapshot: (c: unknown) => proto.buildEmitenteSnapshot.call(proto, c), autorizado },
      undefined, repo, { saveXmlTentativa: async () => "/tmp/devolucao-assinada.xml", readFile: async () => null } as never,
    );
    const draft = await repo.findNfeById(USER, id);
    return orq.emitir(USER, draft, configDls(), { actorUserId: ATOR });
  }

  // ─────────────────────────── leitura do banco (tipos do Postgres) ───────────────────────────

  const contar = async (tabela: string, onde = "", ...args: unknown[]) =>
    Number((await admin.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM "${tabela}" ${onde}`, ...args))[0].n);
  const linhasDoRascunho = async (id: string) => ({
    NfeEmitida: await contar("NfeEmitida", `WHERE "id"=$1`, id),
    NfeDevolucao: await contar("NfeDevolucao", `WHERE "nfeId"=$1`, id),
    NfeDevolucaoItem: await contar("NfeDevolucaoItem", `WHERE "devolucaoNfeId"=$1`, id),
    NfeItem: await contar("NfeItem", `WHERE "nfeId"=$1`, id),
    NfeAuditLog: await contar("NfeAuditLog", `WHERE "nfeId"=$1`, id),
  });
  const notaDe = async (id: string) => (await admin.$queryRawUnsafe<No[]>(`SELECT "id","userId","companyFiscalConfigId","ambiente","modelo","serie","numero","status","tipoOperacao","finalidade",
      "destinoOperacao","naturezaOperacao","destinatarioJson","pagamentosJson","emittedByUserId","chaveAcesso" FROM "NfeEmitida" WHERE "id"=$1`, id))[0];
  const cabecalhoDe = async (id: string) => (await admin.$queryRawUnsafe<No[]>(`SELECT "nfeId","userId","tipo","fonte","escopoSolicitado","devolvidaAposEntrega","confirmadoSemXml","indFinal",
      "origensJson","createdByUserId" FROM "NfeDevolucao" WHERE "nfeId"=$1`, id))[0];
  const refsDe = (id: string) => admin.$queryRawUnsafe<No[]>(`SELECT "id","ordem","originalNfeId","chaveAcessoOriginal","nItemOriginal","codigoOriginal",
      "quantidadeOriginal"::text AS "quantidadeOriginal","valorUnitarioOriginal"::text AS "valorUnitarioOriginal","quantidade"::text AS "quantidade","valor"::text AS "valor",
      "impostoOriginalJson","tributacaoJson" FROM "NfeDevolucaoItem" WHERE "devolucaoNfeId"=$1 ORDER BY "ordem"`, id);
  const itensDe = (id: string) => admin.$queryRawUnsafe<No[]>(`SELECT "numero","codigo","cfop","quantidade"::text AS "quantidade","valorUnitario"::text AS "valorUnitario",
      "valorTotal"::text AS "valorTotal" FROM "NfeItem" WHERE "nfeId"=$1 ORDER BY "numero"`, id);
  const eventosDe = async (id: string) => (await admin.$queryRawUnsafe<Array<{ evento: string }>>(`SELECT "evento" FROM "NfeAuditLog" WHERE "nfeId"=$1 ORDER BY "createdAt","evento"`, id)).map((e) => e.evento);
  const reservasDe = (id: string) => admin.$queryRawUnsafe<No[]>(`SELECT "numero","serie","estado","ambiente","nfeId","requerInutilizacao" FROM "NfeNumeroReserva" WHERE "nfeId"=$1`, id);

  // ─────────────────────────── manual() pelo XML ───────────────────────────

  it("manual() pelo XML: a prévia lê a compra; criar grava nota, cabeçalho e peças nos tipos do schema real; o clique duplo e o 2º clique reabrem o MESMO rascunho", async () => {
    const d = dls();
    const previa = await d.tela.previa(corpoXml(XML_DISAUTO));
    expect(previa).toMatchObject({ chaveAcesso: CHAVE_DISAUTO, numero: 852899, serie: 1, emitenteCnpjCpf: CNPJ_DISAUTO, rascunhoAberto: null });
    expect(previa.itens.map((i: No) => [i.nItem, i.codigo, i.quantidadeOriginal, i.disponivel, i.emRascunho, i.devolvidaAutorizada])).toEqual([
      [1, "11111-1", 3, 3, 0, 0], [2, "22222-2", 2, 2, 0, 0], [3, "33333-3", 1, 1, 0, 0], [4, "44444-4", 4, 4, 0, 0], [5, "33603-3", 1, 1, 0, 0], [6, "24171-7", 1, 1, 0, 0],
    ]);
    // A prévia só lê: nada foi gravado.
    expect(await contar("NfeEmitida")).toBe(0);

    // Clique duplo em "Criar devolução": as duas requisições chegam juntas. O lock da chave
    // (pg_advisory_xact_lock, na transação) põe uma atrás da outra: uma cria, a outra reabre.
    const [a, b] = await Promise.all([d.tela.criar(corpoXml(XML_DISAUTO, ITENS_5_E_6)), d.tela.criar(corpoXml(XML_DISAUTO, ITENS_5_E_6))]);
    expect([a.reutilizado, b.reutilizado].sort()).toEqual([false, true]);
    expect(b.draftId).toBe(a.draftId);
    const id = a.draftId as string;
    expect(await linhasDoRascunho(id)).toEqual({ NfeEmitida: 1, NfeDevolucao: 1, NfeDevolucaoItem: 2, NfeItem: 2, NfeAuditLog: 1 });
    expect(await contar("NfeEmitida")).toBe(1);

    // A nota de devolução, como o Postgres guardou (jsonb volta objeto, numero é integer).
    const nota = await notaDe(id);
    expect(nota).toMatchObject({
      userId: USER, companyFiscalConfigId: CFC, ambiente: "PRODUCAO", modelo: "55", serie: 1, status: "DRAFT", tipoOperacao: "SAIDA", finalidade: "DEVOLUCAO",
      destinoOperacao: "INTERNA", naturezaOperacao: "DEVOLUCAO DE COMPRA", emittedByUserId: ATOR, chaveAcesso: null, pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }],
    });
    expect(nota.numero).toBeLessThan(0); // rascunho não segura número fiscal (fica fora do índice parcial "numero" > 0)
    expect(nota.destinatarioJson).toMatchObject({ tipoPessoa: "PJ", cpfCnpj: CNPJ_DISAUTO, inscricaoEstadual: "258272414", uf: "SC", codMunicipio: "4209102" });

    // O cabeçalho: CHECKs do DDL (tipo, fonte, escopo, indFinal), boolean e jsonb de verdade.
    const cab = await cabecalhoDe(id);
    expect(cab).toMatchObject({ userId: USER, tipo: "COMPRA_SAIDA", fonte: "XML_IMPORTADO", escopoSolicitado: "PARCIAL", indFinal: "0", confirmadoSemXml: false, devolvidaAposEntrega: null, createdByUserId: ATOR });
    expect(cab.origensJson).toHaveLength(1);
    expect(cab.origensJson[0]).toMatchObject({ chaveAcesso: CHAVE_DISAUTO, numero: 852899, serie: 1, crtOriginal: "3", idDest: 1, emitenteCnpjCpf: CNPJ_DISAUTO });
    expect(cab.origensJson[0].itens.map((i: No) => i.nItem)).toEqual([1, 2, 3, 4, 5, 6]);

    // As peças: numeric(15,4)/(15,2) com a escala do DDL; a chave passa no CHECK ^[0-9]{44}$.
    const refs = await refsDe(id);
    expect(refs.map((r) => [r.ordem, r.nItemOriginal, r.codigoOriginal, r.chaveAcessoOriginal, r.originalNfeId, r.quantidadeOriginal, r.valorUnitarioOriginal, r.quantidade, r.valor])).toEqual([
      [1, 5, "33603-3", CHAVE_DISAUTO, null, "1.0000", "123.5600", "1.0000", "123.56"],
      [2, 6, "24171-7", CHAVE_DISAUTO, null, "1.0000", "295.8800", "1.0000", "295.88"],
    ]);
    // O que o jsonb devolve é o que a tela recebe (nenhum campo perdido na ida e volta).
    const detalhe = await d.tela.detalhe(id);
    expect(refs.map((r) => r.tributacaoJson)).toEqual(detalhe.itens.map((i: No) => i.tributacao));
    expect(refs.every((r) => r.impostoOriginalJson !== null && typeof r.impostoOriginalJson === "object")).toBe(true);
    expect(detalhe.itens.map((i: No) => [i.ordem, i.nItem, i.quantidade, i.quantidadeOriginal, i.valor])).toEqual([[1, 5, 1, 1, 123.56], [2, 6, 1, 1, 295.88]]);
    expect(await itensDe(id)).toEqual([
      { numero: 1, codigo: "33603-3", cfop: "", quantidade: "1.0000", valorUnitario: "123.5600", valorTotal: "123.56" },
      { numero: 2, codigo: "24171-7", cfop: "", quantidade: "1.0000", valorUnitario: "295.8800", valorTotal: "295.88" },
    ]);
    expect(await eventosDe(id)).toEqual(["DEVOLUCAO_RASCUNHO_CRIADO"]);

    // A prévia agora aponta o rascunho aberto; as peças 5 e 6 estão nele (rascunho não segura saldo).
    const depois = await d.tela.previa(corpoXml(XML_DISAUTO));
    expect(depois.rascunhoAberto).toBe(id);
    expect(depois.itens.map((i: No) => [i.nItem, i.emRascunho, i.disponivel])).toEqual([[1, 0, 3], [2, 0, 2], [3, 0, 1], [4, 0, 4], [5, 1, 1], [6, 1, 1]]);

    // Outra seleção da mesma nota: reabre, não cria outro (a DLS acumulou 5 da mesma nota).
    expect(await d.tela.criar(corpoXml(XML_DISAUTO, [{ nItem: 2, quantidade: 1 }]))).toEqual({ draftId: id, reutilizado: true });
    // REJEITADA também é "em aberto".
    await admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "status"='REJECTED' WHERE "id"=$1`, id);
    expect(await d.tela.criar(corpoXml(XML_DISAUTO))).toEqual({ draftId: id, reutilizado: true });
    expect(await contar("NfeEmitida")).toBe(1);
    expect(await contar("NfeDevolucao")).toBe(1);
    // O reaproveitamento não mexe nas peças dela.
    expect((await refsDe(id)).map((r) => r.id)).toEqual(refs.map((r) => r.id));
  }, 120000);

  // ─────────────────────────── itens(): salvar um tributo só ───────────────────────────

  it("itens(): CFOP, depois ICMS 900, depois SÓ o PIS/COFINS — o jsonb gravado guarda os três e é o que a tela recebe; a recusa não grava nada", async () => {
    const r = await devolverItens5e6();
    // A resposta da entrega: boolean de verdade no cabeçalho (CASE WHEN $3 THEN $4 …).
    expect(await cabecalhoDe(r.id)).toMatchObject({ devolvidaAposEntrega: true, escopoSolicitado: "PARCIAL" });

    expect(r.comCfop.itens.map((i: No) => i.cfop)).toEqual(["5202", "5202"]);
    const icmsSalvo = r.comIcms.itens.map((i: No) => i.tributacao.icms);
    expect(icmsSalvo.map((x: No) => [x.csosn, x.pICMS, x.modBC])).toEqual([["900", 12, "3"], ["900", 12, "3"]]);

    // Depois do PUT só com PIS/COFINS: o ICMS gravado CONTINUA (hotfix af1cdc66), no banco.
    const refs = await refsDe(r.id);
    expect(refs.map((x) => x.tributacaoJson.icms)).toEqual(icmsSalvo);
    for (const x of refs) {
      expect(x.tributacaoJson.pis).toMatchObject({ cst: "49", p: 0 });
      expect(x.tributacaoJson.cofins).toMatchObject({ cst: "49", p: 0 });
      expect(x.tributacaoJson).toMatchObject({ fonte: "USUARIO", confirmada: true });
    }
    // O banco guardou exatamente o que a tela mostra.
    expect(refs.map((x) => x.tributacaoJson)).toEqual(r.final.itens.map((i: No) => i.tributacao));
    expect(refs.map((x) => [x.ordem, x.nItemOriginal, x.quantidade, x.valor])).toEqual([[1, 5, "1.0000", "123.56"], [2, 6, "1.0000", "295.88"]]);
    expect((await itensDe(r.id)).map((x) => [x.numero, x.codigo, x.cfop, x.quantidade, x.valorTotal])).toEqual([[1, "33603-3", "5202", "1.0000", "123.56"], [2, "24171-7", "5202", "1.0000", "295.88"]]);
    // Cada save apaga e regrava as peças (DELETE + INSERT): continuam duas, uma por item.
    expect(await linhasDoRascunho(r.id)).toMatchObject({ NfeDevolucaoItem: 2, NfeItem: 2 });
    expect(await eventosDe(r.id)).toEqual(["DEVOLUCAO_RASCUNHO_CRIADO", ...Array(4).fill("DEVOLUCAO_ITENS_EDITADOS")]);

    expect(r.final.issues.filter((i: No) => i.severidade === "ERRO")).toEqual([]);
    expect(r.final.podeEmitir).toBe(true);
    expect(r.final.totais).toMatchObject({ totalProdutos: 419.44, totalBcIcms: 419.44, totalIcms: 50.34, totalPis: 0, totalCofins: 0, totalNota: 419.44, completo: true });

    // PIS/COFINS 01 escolhido à mão numa empresa do Simples: 422, e as linhas continuam as mesmas (nem regravadas).
    const antes = await refsDe(r.id);
    const e = await erroDe(r.tela.salvarItens(r.id, [
      item(5, { tributacao: { pis: { cst: "01", p: 1.65 }, cofins: { cst: "01", p: 7.6 } }, confirmarTributacao: true }),
      item(6, { confirmarTributacao: true }),
    ]));
    expect([e.code, e.httpStatus]).toEqual(["TRIBUTACAO_NAO_SUPORTADA", 422]);
    expect(await refsDe(r.id)).toEqual(antes);
    expect(await eventosDe(r.id)).toHaveLength(5);
  }, 120000);

  it("itens(): o escopo é DERIVADO e gravado pelo UPDATE do cabeçalho — a nota inteira vira TOTAL, voltar às peças 5 e 6 volta a PARCIAL", async () => {
    const d = dls();
    const { draftId: id } = await d.tela.criar(corpoXml(XML_DISAUTO, ITENS_5_E_6));
    expect((await cabecalhoDe(id)).escopoSolicitado).toBe("PARCIAL");
    const todas = await d.tela.salvarItens(id, [
      item(1, { quantidade: 3, cfop: "5411" }), item(2, { quantidade: 2 }), item(3), item(4, { quantidade: 4 }), item(5), item(6),
    ]);
    expect(todas.escopo).toBe("TOTAL");
    expect((await cabecalhoDe(id)).escopoSolicitado).toBe("TOTAL");
    expect((await refsDe(id)).map((x) => [x.ordem, x.nItemOriginal, x.quantidade])).toEqual([[1, 1, "3.0000"], [2, 2, "2.0000"], [3, 3, "1.0000"], [4, 4, "4.0000"], [5, 5, "1.0000"], [6, 6, "1.0000"]]);
    const deVolta = await d.tela.salvarItens(id, [item(5), item(6)]);
    expect(deVolta.escopo).toBe("PARCIAL");
    expect((await cabecalhoDe(id)).escopoSolicitado).toBe("PARCIAL");
    expect(await linhasDoRascunho(id)).toMatchObject({ NfeDevolucaoItem: 2, NfeItem: 2 });
  }, 120000);

  // ─────────────────────────── descartar o rascunho ───────────────────────────

  describe.each([
    ["pela numeração V2 (a empresa está na V2: DELETE … RETURNING)", "V2"],
    ["pelo Prisma (a empresa saiu da allowlist da V2: NfeRepository.deleteDraft)", "PRISMA"],
  ] as const)("descartar o rascunho de devolução %s", (_nome, caminho) => {
    it("a nota some e, pelo ON DELETE CASCADE, o cabeçalho, as peças, os itens e a auditoria; o saldo e 'Devoluções em andamento' voltam", async () => {
      const r = await devolverItens5e6();
      const d = dls();
      const antes = await d.uc.abertas(USER);
      expect(antes.abertas.map((a: No) => [a.draftId, a.status, a.gerenciada, a.tipo, a.fonte, a.quantidadeItens, a.numeracao])).toEqual([[r.id, "DRAFT", true, "COMPRA_SAIDA", "XML_IMPORTADO", 2, null]]);
      expect(antes.abertas[0].originais).toEqual([{ chaveAcesso: CHAVE_DISAUTO, numero: 852899, serie: 1 }]);
      expect(await linhasDoRascunho(r.id)).toEqual({ NfeEmitida: 1, NfeDevolucao: 1, NfeDevolucaoItem: 2, NfeItem: 2, NfeAuditLog: 5 });

      const peloPrisma = vi.spyOn(M.NfeRepository.prototype, "deleteDraft");
      if (caminho === "PRISMA") vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", "outra-empresa");
      await new M.NfeDraftUseCase().delete(USER, r.id);
      expect(peloPrisma).toHaveBeenCalledTimes(caminho === "PRISMA" ? 1 : 0);
      if (caminho === "PRISMA") vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);

      expect(await linhasDoRascunho(r.id)).toEqual({ NfeEmitida: 0, NfeDevolucao: 0, NfeDevolucaoItem: 0, NfeItem: 0, NfeAuditLog: 0 });
      for (const t of ["NfeEmitida", "NfeDevolucao", "NfeDevolucaoItem", "NfeItem", "NfeAuditLog"]) expect(await contar(t)).toBe(0);

      // O saldo não guardava nada dele; a prévia não aponta mais rascunho aberto.
      const previa = await d.tela.previa(corpoXml(XML_DISAUTO));
      expect(previa.rascunhoAberto).toBeNull();
      expect(previa.itens.map((i: No) => [i.nItem, i.emRascunho, i.disponivel])).toEqual([[1, 0, 3], [2, 0, 2], [3, 0, 1], [4, 0, 4], [5, 0, 1], [6, 0, 1]]);
      expect((await d.uc.abertas(USER)).abertas).toEqual([]);
      // Criar de novo nasce outro rascunho (o descartado não é "reaberto").
      const nova = await d.tela.criar(corpoXml(XML_DISAUTO, ITENS_5_E_6));
      expect(nova.reutilizado).toBe(false);
      expect(nova.draftId).not.toBe(r.id);
      expect(await linhasDoRascunho(nova.draftId)).toEqual({ NfeEmitida: 1, NfeDevolucao: 1, NfeDevolucaoItem: 2, NfeItem: 2, NfeAuditLog: 1 });
    }, 120000);
  });

  it("descartar a devolução REJEITADA que segura número (produção): pede confirmação; confirmado, as linhas somem e o nº fica ABANDONADO para inutilizar", async () => {
    const r = await devolverItens5e6();
    h.cStat = 225;
    const res = await emitir(r.id);
    expect(res).toMatchObject({ success: false, status: "REJECTED" });
    expect(h.transmitidas).toEqual([PROXIMO_NUMERO]);
    expect(await reservasDe(r.id)).toEqual([{ numero: PROXIMO_NUMERO, serie: 1, estado: "REJEITADO", ambiente: "PRODUCAO", nfeId: r.id, requerInutilizacao: false }]);
    // "Devoluções em andamento" mostra o nº preso (reservasVivas, ANY($2::text[])).
    const d = dls();
    const [aberta] = (await d.uc.abertas(USER)).abertas;
    expect(aberta).toMatchObject({ draftId: r.id, status: "REJECTED", numeracao: { numero: PROXIMO_NUMERO, serie: 1, estado: "REJEITADO", ambiente: "PRODUCAO" } });

    const semConfirmar = await erroDe(new M.NfeDraftUseCase().delete(USER, r.id));
    expect(semConfirmar.code).toBe("NUMERACAO_CONFIRMAR_DESCARTE");
    expect(await linhasDoRascunho(r.id)).toMatchObject({ NfeEmitida: 1, NfeDevolucao: 1, NfeDevolucaoItem: 2, NfeItem: 2 });

    await new M.NfeDraftUseCase().delete(USER, r.id, true);
    expect(await linhasDoRascunho(r.id)).toEqual({ NfeEmitida: 0, NfeDevolucao: 0, NfeDevolucaoItem: 0, NfeItem: 0, NfeAuditLog: 0 });
    // A reserva não tem FK para a nota: sobrevive, ABANDONADA, e é o que a inutilização lê.
    expect(await reservasDe(r.id)).toEqual([{ numero: PROXIMO_NUMERO, serie: 1, estado: "ABANDONADO", ambiente: "PRODUCAO", nfeId: r.id, requerInutilizacao: true }]);
    const previa = await d.tela.previa(corpoXml(XML_DISAUTO));
    expect(previa.rascunhoAberto).toBeNull();
    expect(previa.itens.filter((i: No) => i.nItem >= 5).map((i: No) => [i.nItem, i.emRascunho, i.disponivel])).toEqual([[5, 0, 1], [6, 0, 1]]);
    expect((await d.uc.abertas(USER)).abertas).toEqual([]);
  }, 120000);

  // ─────────────────────────── o saldo depois de AUTORIZADA ───────────────────────────

  it("AUTORIZADA pela emissão V2 (só o transporte é simulado): o livro marca as peças 5 e 6 e a mesma compra só devolve o que sobrou", async () => {
    const r = await devolverItens5e6();
    const res = await emitir(r.id);
    expect(res).toMatchObject({ success: true, status: "AUTHORIZED", numero: PROXIMO_NUMERO, serie: 1 });
    expect(h.transmitidas).toEqual([PROXIMO_NUMERO]);

    // O XML que foi à SEFAZ (builder real, sobre a linha lida do Postgres): a devolução da DLS.
    expect(h.xmls).toHaveLength(1);
    const nfe = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(h.xmls[0]).NFe.infNFe;
    expect(nfe.ide).toMatchObject({ nNF: String(PROXIMO_NUMERO), natOp: "DEVOLUCAO DE COMPRA", tpNF: "1", idDest: "1", tpAmb: "1", finNFe: "4", indFinal: "0" });
    expect(lista(nfe.ide.NFref)).toEqual([{ refNFe: CHAVE_DISAUTO }]);
    expect(nfe.emit).toMatchObject({ CNPJ: CNPJ_DLS, CRT: "1" });
    expect(nfe.dest).toMatchObject({ CNPJ: CNPJ_DISAUTO, IE: "258272414" });
    expect(lista(nfe.det).map((x: No) => [x.prod.cProd, x.prod.CFOP, Object.keys(x.imposto.ICMS)[0], x.imposto.PIS.PISOutr?.CST])).toEqual([
      ["33603-3", "5202", "ICMSSN900", "49"], ["24171-7", "5202", "ICMSSN900", "49"],
    ]);
    expect(nfe.total.ICMSTot).toMatchObject({ vBC: "419.44", vICMS: "50.34", vST: "0.00", vPIS: "0.00", vCOFINS: "0.00", vNF: "419.44" });

    // No banco: a nota com o nº e a chave, a reserva AUTORIZADO, e DEVOLUCAO_AUTORIZADA uma vez.
    const nota = await notaDe(r.id);
    expect(nota).toMatchObject({ status: "AUTHORIZED", numero: PROXIMO_NUMERO, serie: 1 });
    expect(nfe["@_Id"]).toBe(`NFe${nota.chaveAcesso}`);
    expect(nota.chaveAcesso.slice(6, 20)).toBe(CNPJ_DLS);
    expect(await reservasDe(r.id)).toEqual([{ numero: PROXIMO_NUMERO, serie: 1, estado: "AUTORIZADO", ambiente: "PRODUCAO", nfeId: r.id, requerInutilizacao: false }]);
    const autorizadas = async () => (await eventosDe(r.id)).filter((e) => e === "DEVOLUCAO_AUTORIZADA").length;
    expect(await autorizadas()).toBe(1);
    // O replay (consulta depois de uma queda) chama de novo: idempotente no banco real.
    await new M.Devolucao().registrarAutorizacao(USER, r.id);
    expect(await autorizadas()).toBe(1);

    // O livro de devoluções (linhasSaldo: JOIN nota + cabeçalho, numeric::text).
    const livro = (await new M.DevolucaoRepo().linhasSaldo(USER, CHAVE_DISAUTO)).sort((x: No, y: No) => x.nItem - y.nItem);
    expect(livro.map((l: No) => [l.chave, l.nItem, l.quantidade, l.quantidadeOriginal, l.statusDevolucao, l.devolucaoNfeId, l.numeroDevolucao, l.serieDevolucao, l.fonteDevolucao])).toEqual([
      [CHAVE_DISAUTO, 5, "1.0000", "1.0000", "AUTHORIZED", r.id, PROXIMO_NUMERO, 1, "XML_IMPORTADO"],
      [CHAVE_DISAUTO, 6, "1.0000", "1.0000", "AUTHORIZED", r.id, PROXIMO_NUMERO, 1, "XML_IMPORTADO"],
    ]);
    expect(livro.every((l: No) => l.criadaEm instanceof Date)).toBe(true);

    // A mesma compra de novo: 5 e 6 sem saldo; a autorizada não é rascunho aberto.
    const d = dls();
    const previa = await d.tela.previa(corpoXml(XML_DISAUTO));
    expect(previa.rascunhoAberto).toBeNull();
    expect(previa.itens.map((i: No) => [i.nItem, i.disponivel, i.devolvidaAutorizada, i.emRascunho])).toEqual([[1, 3, 0, 0], [2, 2, 0, 0], [3, 1, 0, 0], [4, 4, 0, 0], [5, 0, 1, 0], [6, 0, 1, 0]]);

    // Pedir de novo a peça 5: recusa pelo saldo, e nada é criado.
    const e = await erroDe(d.tela.criar(corpoXml(XML_DISAUTO, [{ nItem: 5, quantidade: 1 }])));
    expect(e.code).toBe("SALDO_INSUFICIENTE");
    expect(e.issues?.map((i: No) => [i.code, i.severidade])).toEqual([["SALDO_EXCEDIDO", "ERRO"]]);
    expect(e.issues?.[0].mensagem).toContain("33603-3");
    expect(await contar("NfeEmitida")).toBe(1);

    // Sem seleção: nasce com o que sobrou; e a peça 5 não entra nela pelo editor.
    const segunda = await d.tela.criar(corpoXml(XML_DISAUTO));
    expect(segunda.reutilizado).toBe(false);
    expect(segunda.draftId).not.toBe(r.id);
    expect((await refsDe(segunda.draftId)).map((x) => [x.nItemOriginal, x.quantidade])).toEqual([[1, "3.0000"], [2, "2.0000"], [3, "1.0000"], [4, "4.0000"]]);
    expect((await cabecalhoDe(segunda.draftId)).escopoSolicitado).toBe("PARCIAL");
    const e2 = await erroDe(d.tela.salvarItens(segunda.draftId, [item(2, { quantidade: 2 }), item(5)]));
    expect(e2.code).toBe("SALDO_INSUFICIENTE");
    expect(e2.issues?.map((i: No) => [i.code, i.nItem, i.chaveAcesso])).toEqual([["SALDO_EXCEDIDO", 5, CHAVE_DISAUTO]]);

    // A autorizada não é descartável pelo DELETE de rascunho: nada dela some.
    await expect(new M.NfeDraftUseCase().delete(USER, r.id)).rejects.toThrow("Rascunho não encontrado");
    expect(await linhasDoRascunho(r.id)).toMatchObject({ NfeEmitida: 1, NfeDevolucao: 1, NfeDevolucaoItem: 2, NfeItem: 2 });
  }, 120000);
});
