/**
 * Fixtures dos testes do CASO DE USO da devolução (G2): a DLS AUTO PEÇAS (Simples,
 * SC) devolvendo à DISAUTO (regime normal, SC) os itens 5 e 6 da NF-e 852899.
 * Não é spec — só o que os specs `devolucao-caso-de-uso-*.spec.ts` montam.
 */
import { vi } from "vitest";
import { calcularDvChaveAcesso } from "../../../app/fiscal/domain/chave-acesso-dv";
import { NfeDevolucaoUseCase } from "../../../app/usecases/nfe-devolucao.usecase";
import type { LinhaSaldoDevolucao } from "../../../app/fiscal/devolucao/saldo";

export const CFC = "cfg-dls";
export const CNPJ_DLS = "57502966000144";
export const CNPJ_DISAUTO = "80689839000975";

export function chave(cnpj: string, numero: number, cUF = "42"): string {
  const base = cUF + "2609" + cnpj + "55" + "001" + String(numero).padStart(9, "0") + "1" + "75799182";
  return base + calcularDvChaveAcesso(base)!;
}
export const CHAVE_DISAUTO = chave(CNPJ_DISAUTO, 852899);

export function configDls(over: Record<string, unknown> = {}) {
  return {
    id: CFC, userId: "tenant", cnpj: CNPJ_DLS, uf: "SC", ambiente: "HOMOLOGACAO", providerName: "SEFAZ_DIRECT",
    providerToken: null, regimeTributario: "SIMPLES", serieNfe: 1, razaoSocial: "DLS AUTO PECAS", ...over,
  };
}

export function stubFlags() {
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
  vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", CFC);
}

export interface ItemXml {
  nItem: number; cProd: string; xProd: string; qCom: number; vUnCom: number; vDesc?: number; cfop?: string; imposto: string;
}

/** ICMS 00 a 12% + PIS/COFINS 01 da DISAUTO (item 5, bomba). */
export const IMPOSTO_00_01 = (vBC: number) =>
  `<ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>${vBC.toFixed(2)}</vBC><pICMS>12.00</pICMS><vICMS>${(vBC * 0.12).toFixed(2)}</vICMS></ICMS00></ICMS>` +
  `<PIS><PISAliq><CST>01</CST><vBC>${vBC.toFixed(2)}</vBC><pPIS>1.65</pPIS><vPIS>${(vBC * 0.0165).toFixed(2)}</vPIS></PISAliq></PIS>` +
  `<COFINS><COFINSAliq><CST>01</CST><vBC>${vBC.toFixed(2)}</vBC><pCOFINS>7.60</pCOFINS><vCOFINS>${(vBC * 0.076).toFixed(2)}</vCOFINS></COFINSAliq></COFINS>`;

/** A nota de COMPRA da DISAUTO para a DLS, autorizada (procNFe), no ambiente de homologação. */
export function xmlCompraDisauto(itens: ItemXml[], opts: { chave?: string; tpAmb?: "1" | "2" } = {}): string {
  const ch = opts.chave ?? CHAVE_DISAUTO;
  const tpAmb = opts.tpAmb ?? "2";
  const det = itens.map((i) => `<det nItem="${i.nItem}"><prod><cProd>${i.cProd}</cProd><cEAN>SEM GTIN</cEAN><xProd>${i.xProd}</xProd><NCM>84133090</NCM>` +
    `<CFOP>${i.cfop ?? "5102"}</CFOP><uCom>UN</uCom><qCom>${i.qCom.toFixed(4)}</qCom><vUnCom>${i.vUnCom.toFixed(4)}</vUnCom><vProd>${(i.qCom * i.vUnCom).toFixed(2)}</vProd>` +
    (i.vDesc ? `<vDesc>${i.vDesc.toFixed(2)}</vDesc>` : "") +
    `<cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>${i.qCom.toFixed(4)}</qTrib><vUnTrib>${i.vUnCom.toFixed(4)}</vUnTrib><indTot>1</indTot></prod><imposto>${i.imposto}</imposto></det>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${ch}" versao="4.00">` +
    `<ide><cUF>42</cUF><natOp>VENDA</natOp><mod>55</mod><serie>1</serie><nNF>852899</nNF><dhEmi>2026-09-10T10:00:00-03:00</dhEmi><tpNF>1</tpNF><idDest>1</idDest>` +
    `<cMunFG>4209102</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>${ch.slice(-1)}</cDV><tpAmb>${tpAmb}</tpAmb><finNFe>1</finNFe><indFinal>0</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>X</verProc></ide>` +
    `<emit><CNPJ>${CNPJ_DISAUTO}</CNPJ><xNome>DISAUTO</xNome><enderEmit><xLgr>RUA A</xLgr><nro>1</nro><xBairro>CENTRO</xBairro><cMun>4209102</cMun><xMun>JOINVILLE</xMun><UF>SC</UF><CEP>89200000</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderEmit><IE>258272414</IE><CRT>3</CRT></emit>` +
    `<dest><CNPJ>${CNPJ_DLS}</CNPJ><xNome>DLS AUTO PECAS</xNome><enderDest><xLgr>RUA B</xLgr><nro>2</nro><xBairro>CENTRO</xBairro><cMun>4209102</cMun><xMun>JOINVILLE</xMun><UF>SC</UF><CEP>89200000</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderDest><indIEDest>1</indIEDest><IE>123</IE></dest>` +
    det +
    `<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vProd>0.00</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vIPI>0.00</vIPI><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>0.00</vNF></ICMSTot></total>` +
    `<transp><modFrete>9</modFrete></transp><pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag></infNFe></NFe>` +
    `<protNFe versao="4.00"><infProt><tpAmb>${tpAmb}</tpAmb><verAplic>X</verAplic><chNFe>${ch}</chNFe><dhRecbto>2026-09-10T10:00:31-03:00</dhRecbto><nProt>142260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>`;
}

/** Os 6 itens da nota da DISAUTO (qCom 3,1,1,1,1,1), como no origensJson da DLS. */
export const ITENS_DISAUTO: ItemXml[] = [
  { nItem: 1, cProd: "11111-1", xProd: "OLEO LUBRAX", qCom: 3, vUnCom: 40, cfop: "5655", imposto: IMPOSTO_00_01(120) },
  { nItem: 2, cProd: "22222-2", xProd: "FILTRO", qCom: 1, vUnCom: 30, imposto: IMPOSTO_00_01(30) },
  { nItem: 3, cProd: "33333-3", xProd: "CORREIA", qCom: 1, vUnCom: 50, imposto: IMPOSTO_00_01(50) },
  { nItem: 4, cProd: "44444-4", xProd: "VELA", qCom: 1, vUnCom: 20, imposto: IMPOSTO_00_01(20) },
  { nItem: 5, cProd: "33603-3", xProd: "BOMBA", qCom: 1, vUnCom: 123.56, imposto: IMPOSTO_00_01(123.56) },
  { nItem: 6, cProd: "24171-7", xProd: "10255 SCHADEK BOMBA OLEO", qCom: 1, vUnCom: 295.88, imposto: IMPOSTO_00_01(295.88) },
];

/** Linha do livro de devoluções (NfeDevolucaoItem + status da nota de devolução). */
export function linha(nItem: number, quantidade: number, status: string, extra: Partial<LinhaSaldoDevolucao> = {}): LinhaSaldoDevolucao {
  return { chave: CHAVE_DISAUTO, nItem, quantidade: String(quantidade), statusDevolucao: status, devolucaoNfeId: `dev-${status}-${nItem}`, ...extra };
}

/** Repositório em memória: só o que o caso de uso chama. */
export function repoEmMemoria(estado: {
  linhas?: LinhaSaldoDevolucao[];
  aberta?: string | null;
  persistidas?: Record<string, unknown>;
  notaPorChave?: unknown;
  eventos?: string[];
} = {}) {
  const chamadas = {
    criados: [] as any[],
    gravados: [] as Array<{ itens: any[]; refs: any[]; escopo?: string }>,
    aberta: [] as any[],
    audits: [] as Array<{ nfeId: string; evento: string; detalhes: unknown }>,
    sql: [] as Array<{ sql: string; args: unknown[] }>,
  };
  const repo = {
    db: { $queryRawUnsafe: async () => [] },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({ $executeRawUnsafe: async (sql: string, ...args: unknown[]) => { chamadas.sql.push({ sql, args }); return 1; }, $queryRawUnsafe: async () => [] }),
    lockOrigens: async () => undefined,
    lockRascunho: async () => undefined,
    linhasSaldo: async () => estado.linhas ?? [],
    aberta: async (...args: unknown[]) => { chamadas.aberta.push(args); return estado.aberta ?? null; },
    get: async (_u: string, id: string) => (estado.persistidas?.[id] as never) ?? null,
    nota: async (_u: string, id: string) => ((estado.persistidas?.[id] as { nota?: unknown })?.nota as never) ?? null,
    notaPorChave: async () => estado.notaPorChave ?? null,
    criar: async (_tx: unknown, _u: string, _a: string, m: unknown) => { chamadas.criados.push(m); return "novo-rascunho"; },
    gravarItens: async (_tx: unknown, _u: string, _id: string, itens: any[], refs: any[], escopo?: string) => { chamadas.gravados.push({ itens, refs, escopo }); },
    audit: async (_tx: unknown, _u: string, nfeId: string, evento: string, detalhes: unknown) => { chamadas.audits.push({ nfeId, evento, detalhes }); },
    temEvento: async (_tx: unknown, _u: string, _id: string, evento: string) => (estado.eventos ?? []).includes(evento),
    escopoDe: async () => null,
  };
  return { repo, chamadas };
}

export function casoDeUso(repo: unknown, config = configDls()) {
  const configs = { findByIdForUser: async () => config, findByUserId: async () => config };
  return new NfeDevolucaoUseCase(repo as never, configs as never, {} as never);
}

/** Captura o DevolucaoError (ou falha se nada foi lançado). */
export async function erroDe(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error("esperava um erro e a chamada passou");
}
