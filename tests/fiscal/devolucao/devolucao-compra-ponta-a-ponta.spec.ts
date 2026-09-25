/**
 * Devolução de COMPRA ponta a ponta — do XML do fornecedor ao XML montado
 * (achado N-completude-2: nenhum teste percorria esse caminho inteiro).
 *
 * O cenário é o da DLS AUTO PEÇAS (Simples Nacional, CRT 1, SC) devolvendo à
 * DISAUTO (regime normal, CRT 3, SC — operação interna) os itens 5 e 6 de uma
 * nota de compra com 6 itens: o 1 com ICMS CST 10 e ICMS-ST (óleo), os de 2 a
 * 6 com ICMS 00 a 12% e PIS/COFINS 01 ou 04. Dados anonimizados, no formato da
 * nota real (item 5: base do PIS sem o ICMS, R$ 108,73; item 6: PIS 04).
 *
 * O caminho é o de produção, peça por peça:
 *   corpo que a tela manda → parser da rota (contrato.ts) → NfeDevolucaoUseCase
 *   (previaManual, manual, cabecalho, itens, detalhe, contextoEmissao) →
 *   NfeDevolucaoRepository DE VERDADE → calcularDevolucao →
 *   NfeXmlBuilderSefazService.build (o mesmo que SefazDirectProvider.prepararEmissao
 *   chama — aqui sem assinatura e sem rede).
 *
 * Só o Postgres é simulado: `BancoEmMemoria` responde ao SQL que o repositório
 * escreve — numeric com a escala do schema (e lido como texto, como o Decimal do
 * Prisma), jsonb ida e volta em texto (nenhum objeto compartilhado entre gravar e
 * ler), NOT NULL, índices únicos e ROLLBACK da transação. SQL que ele não conhece
 * FALHA o teste: nada responde "vazio" em silêncio.
 *
 * O modo de referência (NOTA até 04/10, ITEM desde 05/10 em produção) é fixado
 * pela variável NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE — o teste não depende do dia.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XMLParser } from "fast-xml-parser";

import { makeConfig } from "../__helpers__/test-draft";
import { CFC, CHAVE_DISAUTO, CNPJ_DISAUTO, CNPJ_DLS, chave, stubFlags } from "./devolucao-caso-de-uso-fixtures";
import { NfeDevolucaoUseCase } from "../../../app/usecases/nfe-devolucao.usecase";
import { NfeDevolucaoRepository } from "../../../app/fiscal/devolucao/devolucao.repository";
import { DevolucaoError } from "../../../app/fiscal/devolucao/devolucao.errors";
import { parseAtualizarCabecalhoBody, parseAtualizarItensBody, parseManualBody } from "../../../app/fiscal/devolucao/contrato";
import type { DevolucaoDetalhe } from "../../../app/fiscal/devolucao/contrato";
import { calcularDevolucao } from "../../../app/fiscal/devolucao/emissao";
import { NfeXmlBuilderSefazService } from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { NfeEmissionUseCase } from "../../../app/usecases/nfe-emission.usecase";
import type { CompanyFiscalConfig } from "../../../app/interfaces/company-fiscal.interface";
import type { NfeDraftResponse } from "../../../app/interfaces/nfe.interface";

const USER = "tenant-dls";
const ATOR = "dona-da-dls";
const NUMERO_DEVOLUCAO = 716;
const CNF = "87654321";
const DH_EMI = new Date("2026-09-24T15:00:00-03:00");

// ─────────────────────────── a nota de compra da DISAUTO ───────────────────────────

const r2 = (x: number) => Math.round(x * 100 + 1e-9) / 100;
const f2 = (x: number) => x.toFixed(2);

interface ItemCompra {
  nItem: number; cProd: string; xProd: string; ncm: string; cfop: string; qCom: number; vUnCom: number;
  icms: { cst: "00" | "10"; vBC: number; vICMS: number; st?: { pMVAST: number; vBCST: number; pICMSST: number; vICMSST: number } };
  pisCofins: "01" | "04";
  /** Base do PIS/COFINS 01 (a DISAUTO tira o ICMS da base). */
  vBCPis?: number;
  /** Desconto da linha (a base do ICMS da DISAUTO já vem líquida dele). */
  vDesc?: number;
}

const LUBRAX: ItemCompra = {
  nItem: 1, cProd: "11111-1", xProd: "OLEO LUBRAX 5W30 1L", ncm: "27101932", cfop: "5403", qCom: 3, vUnCom: 39.15,
  icms: { cst: "10", vBC: 117.45, vICMS: 14.09, st: { pMVAST: 71.03, vBCST: 200.87, pICMSST: 17, vICMSST: 20.05 } }, pisCofins: "04",
};
const FILTRO: ItemCompra = { nItem: 2, cProd: "22222-2", xProd: "FILTRO DE AR", ncm: "84213100", cfop: "5102", qCom: 2, vUnCom: 30, icms: { cst: "00", vBC: 60, vICMS: 7.2 }, pisCofins: "01", vBCPis: 52.8 };
const CORREIA: ItemCompra = { nItem: 3, cProd: "33333-3", xProd: "CORREIA DENTADA", ncm: "40103900", cfop: "5102", qCom: 1, vUnCom: 50, icms: { cst: "00", vBC: 50, vICMS: 6 }, pisCofins: "01", vBCPis: 44 };
const VELA: ItemCompra = { nItem: 4, cProd: "44444-4", xProd: "VELA DE IGNICAO", ncm: "85111000", cfop: "5102", qCom: 4, vUnCom: 20, icms: { cst: "00", vBC: 80, vICMS: 9.6 }, pisCofins: "01", vBCPis: 70.4 };
const BOMBA_DAGUA: ItemCompra = { nItem: 5, cProd: "33603-3", xProd: "BOMBA DAGUA", ncm: "84133090", cfop: "5102", qCom: 1, vUnCom: 123.56, icms: { cst: "00", vBC: 123.56, vICMS: 14.83 }, pisCofins: "01", vBCPis: 108.73 };
const BOMBA_OLEO: ItemCompra = { nItem: 6, cProd: "24171-7", xProd: "10255 SCHADEK BOMBA OLEO", ncm: "84133090", cfop: "5102", qCom: 1, vUnCom: 295.88, icms: { cst: "00", vBC: 295.88, vICMS: 35.51 }, pisCofins: "04" };
const NOTA_DISAUTO: ItemCompra[] = [LUBRAX, FILTRO, CORREIA, VELA, BOMBA_DAGUA, BOMBA_OLEO];

const vProdDe = (i: ItemCompra) => r2(i.qCom * i.vUnCom);
const vPisDe = (i: ItemCompra) => (i.pisCofins === "01" ? r2((i.vBCPis ?? 0) * 0.0165) : 0);
const vCofinsDe = (i: ItemCompra) => (i.pisCofins === "01" ? r2((i.vBCPis ?? 0) * 0.076) : 0);

/** O procNFe autorizado da compra (DISAUTO → DLS), com os totais fechando. */
function xmlDaCompra(itens: ItemCompra[], o: { nNF: number; tpAmb: "1" | "2" }): string {
  const ch = chave(CNPJ_DISAUTO, o.nNF);
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
      `<cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>${i.qCom.toFixed(4)}</qTrib><vUnTrib>${i.vUnCom.toFixed(10)}</vUnTrib>${i.vDesc ? `<vDesc>${f2(i.vDesc)}</vDesc>` : ""}<indTot>1</indTot></prod>` +
      `<imposto><ICMS>${icms}</ICMS>${pisCofins}</imposto></det>`;
  }).join("");
  const soma = (fn: (i: ItemCompra) => number) => r2(itens.reduce((n, i) => n + fn(i), 0));
  const vProd = soma(vProdDe);
  const vST = soma((i) => i.icms.st?.vICMSST ?? 0);
  const vDesc = soma((i) => i.vDesc ?? 0);
  const vNF = r2(vProd - vDesc + vST);
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${ch}" versao="4.00">` +
    `<ide><cUF>42</cUF><cNF>${ch.slice(35, 43)}</cNF><natOp>VENDA DE MERCADORIA</natOp><mod>55</mod><serie>1</serie><nNF>${o.nNF}</nNF><dhEmi>2026-09-10T10:00:00-03:00</dhEmi>` +
    `<tpNF>1</tpNF><idDest>1</idDest><cMunFG>4209102</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>${ch.slice(-1)}</cDV><tpAmb>${o.tpAmb}</tpAmb><finNFe>1</finNFe>` +
    `<indFinal>0</indFinal><indPres>9</indPres><procEmi>0</procEmi><verProc>ERP-FORNECEDOR</verProc></ide>` +
    `<emit><CNPJ>${CNPJ_DISAUTO}</CNPJ><xNome>DISAUTO DISTRIBUIDORA DE AUTOPECAS LTDA</xNome><enderEmit><xLgr>RUA DO FORNECEDOR</xLgr><nro>1000</nro><xBairro>DISTRITO INDUSTRIAL</xBairro>` +
    `<cMun>4209102</cMun><xMun>JOINVILLE</xMun><UF>SC</UF><CEP>89219500</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderEmit><IE>258272414</IE><CRT>3</CRT></emit>` +
    `<dest><CNPJ>${CNPJ_DLS}</CNPJ><xNome>DLS AUTO PECAS LTDA</xNome><enderDest><xLgr>RUA DAS PECAS</xLgr><nro>200</nro><xBairro>CENTRO</xBairro><cMun>4209102</cMun>` +
    `<xMun>JOINVILLE</xMun><UF>SC</UF><CEP>89201000</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderDest><indIEDest>1</indIEDest><IE>261234567</IE></dest>` +
    det +
    `<total><ICMSTot><vBC>${f2(soma((i) => i.icms.vBC))}</vBC><vICMS>${f2(soma((i) => i.icms.vICMS))}</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP>` +
    `<vBCST>${f2(soma((i) => i.icms.st?.vBCST ?? 0))}</vBCST><vST>${f2(vST)}</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${f2(vProd)}</vProd>` +
    `<vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>${f2(vDesc)}</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>${f2(soma(vPisDe))}</vPIS>` +
    `<vCOFINS>${f2(soma(vCofinsDe))}</vCOFINS><vOutro>0.00</vOutro><vNF>${f2(vNF)}</vNF></ICMSTot></total>` +
    `<transp><modFrete>0</modFrete></transp><pag><detPag><tPag>15</tPag><vPag>${f2(vNF)}</vPag></detPag></pag></infNFe></NFe>` +
    `<protNFe versao="4.00"><infProt><tpAmb>${o.tpAmb}</tpAmb><verAplic>SVRS202609</verAplic><chNFe>${ch}</chNFe><dhRecbto>2026-09-10T10:00:31-03:00</dhRecbto>` +
    `<nProt>342260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>`;
}

// ─────────────────────────── o banco (só o que o repositório usa) ───────────────────────────

type Linha = Record<string, unknown>;
type Tabela = "NfeEmitida" | "NfeItem" | "NfeDevolucao" | "NfeDevolucaoItem" | "NfeAuditLog";
const TABELAS: readonly Tabela[] = ["NfeEmitida", "NfeItem", "NfeDevolucao", "NfeDevolucaoItem", "NfeAuditLog"];

/** Colunas numeric e a escala do schema (o Postgres arredonda ao gravar). */
const ESCALA: Partial<Record<Tabela, Record<string, number>>> = {
  NfeEmitida: { valorFrete: 2 },
  NfeItem: { quantidade: 4, valorUnitario: 4, valorTotal: 2, desconto: 2 },
  NfeDevolucaoItem: { quantidadeOriginal: 4, valorUnitarioOriginal: 4, quantidade: 4, valor: 2 },
};
const JSONB: Partial<Record<Tabela, readonly string[]>> = {
  NfeEmitida: ["destinatarioJson", "emitenteJson", "transportadoraJson", "totaisJson", "notasReferenciadasJson", "exportacaoJson", "pagamentosJson", "duplicatasJson", "volumesJson"],
  NfeItem: ["tributosJson"],
  NfeDevolucao: ["origensJson"],
  NfeDevolucaoItem: ["impostoOriginalJson", "tributacaoJson"],
  NfeAuditLog: ["detalhes"],
};
const NAO_NULO: Partial<Record<Tabela, readonly string[]>> = {
  NfeEmitida: ["id", "userId", "ambiente", "modelo", "serie", "numero", "tipoOperacao", "finalidade", "destinoOperacao", "naturezaOperacao", "indPresenca", "destinatarioJson", "status", "emittedByUserId"],
  NfeItem: ["id", "nfeId", "numero", "codigo", "descricao", "ncm", "cfop", "origem", "unidade", "quantidade", "valorUnitario", "valorTotal"],
  NfeDevolucao: ["id", "nfeId", "userId", "tipo", "fonte", "escopoSolicitado", "indFinal", "origensJson", "createdByUserId"],
  NfeDevolucaoItem: ["id", "devolucaoNfeId", "userId", "ordem", "chaveAcessoOriginal", "nItemOriginal", "codigoOriginal", "quantidade", "valor", "tributacaoJson"],
};
const UNICOS: Partial<Record<Tabela, ReadonlyArray<readonly string[]>>> = {
  NfeEmitida: [["id"]],
  NfeItem: [["id"]],
  NfeDevolucao: [["nfeId"]],
  NfeDevolucaoItem: [["devolucaoNfeId", "ordem"], ["devolucaoNfeId", "chaveAcessoOriginal", "nItemOriginal"]],
};
/** Colunas de NfeEmitida que o INSERT do rascunho não preenche (o banco devolve NULL ou o default). */
const NFE_EMITIDA_PADRAO: Linha = {
  orderId: null, customerId: null, companyFiscalConfigId: null, modelo: "55", chaveAcesso: null, intermediador: null, numeroPedido: null,
  informacoesComplementares: null, dataEmissao: null, dataSaida: null, emitenteJson: null, modalidadeFrete: null, transportadoraJson: null,
  valorFrete: null, totaisJson: null, notasReferenciadasJson: null, exportacaoJson: null, pagamentosJson: null, duplicatasJson: null,
  volumesJson: null, protocoloAutorizacao: null, dataAutorizacao: null, motivoRejeicao: null, cStatRejeicao: null, xmlOriginalPath: null,
  xmlAssinadoPath: null, xmlAutorizadoPath: null, danfePdfPath: null,
};

/** numeric(p, escala): arredonda meio-para-longe-do-zero sobre o texto decimal, como o Postgres. */
function numerico(v: unknown, escala: number): string {
  const n = Number(v);
  if (typeof v === "boolean" || !Number.isFinite(n)) throw new Error(`invalid input syntax for type numeric: "${String(v)}"`);
  const inteiro = Math.round(Number(`${Math.abs(n)}e${escala}`));
  return (Math.sign(n) * Number(`${inteiro}e-${escala}`)).toFixed(escala);
}

function dividirValores(s: string): string[] {
  const out: string[] = [];
  let atual = "";
  let prof = 0;
  let aspas = false;
  for (const c of s) {
    if (c === "'") aspas = !aspas;
    if (!aspas && c === "(") prof++;
    if (!aspas && c === ")") prof--;
    if (!aspas && prof === 0 && c === ",") { out.push(atual.trim()); atual = ""; continue; }
    atual += c;
  }
  if (atual.trim()) out.push(atual.trim());
  return out;
}

const digitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");

class BancoEmMemoria {
  tabelas: Record<Tabela, Linha[]> = { NfeEmitida: [], NfeItem: [], NfeDevolucao: [], NfeDevolucaoItem: [], NfeAuditLog: [] };
  private seq = 0;

  async $transaction<T>(fn: (tx: BancoEmMemoria) => Promise<T>): Promise<T> {
    const antes = structuredClone(this.tabelas);
    try {
      return await fn(this);
    } catch (e) {
      this.tabelas = antes; // ROLLBACK
      throw e;
    }
  }
  async $queryRawUnsafe(sql: string, ...args: unknown[]): Promise<Linha[]> {
    const r = this.executar(sql, args);
    return typeof r === "number" ? [] : r;
  }
  async $executeRawUnsafe(sql: string, ...args: unknown[]): Promise<number> {
    const r = this.executar(sql, args);
    return typeof r === "number" ? r : r.length;
  }

  /** O que a finalização da emissão grava na nota autorizada (o repositório de devolução não faz isso). */
  autorizar(nfeId: string, numero: number, chaveAcesso: string): void {
    const n = this.tabelas.NfeEmitida.find((x) => x.id === nfeId);
    if (!n) throw new Error(`nota ${nfeId} não existe`);
    Object.assign(n, { status: "AUTHORIZED", numero, chaveAcesso, updatedAt: new Date(Date.now() + this.seq++) });
  }

  /** O que está gravado, como o Postgres devolveria num SELECT * (cópia nova). */
  linhas(t: Tabela): Linha[] {
    return this.tabelas[t].map((l) => this.ler(t, l, false));
  }

  private ler(t: Tabela, l: Linha, numericoComoNumero: boolean): Linha {
    const out: Linha = {};
    for (const [k, v] of Object.entries(l)) {
      if (JSONB[t]?.includes(k)) out[k] = v === null || v === undefined ? null : JSON.parse(v as string);
      else if (ESCALA[t]?.[k] !== undefined) out[k] = v === null || v === undefined ? null : numericoComoNumero ? Number(v) : String(v);
      else if (v instanceof Date) out[k] = numericoComoNumero ? v.toISOString() : new Date(v.getTime());
      else out[k] = v;
    }
    return out;
  }

  private gravar(t: Tabela, linha: Linha): void {
    for (const c of NAO_NULO[t] ?? []) {
      if (linha[c] === null || linha[c] === undefined) throw new Error(`null value in column "${c}" of relation "${t}" violates not-null constraint`);
    }
    for (const [c, escala] of Object.entries(ESCALA[t] ?? {})) {
      if (linha[c] !== null && linha[c] !== undefined) linha[c] = numerico(linha[c], escala);
    }
    for (const unico of UNICOS[t] ?? []) {
      const chaveDe = (l: Linha) => unico.map((c) => String(l[c])).join("|");
      if (this.tabelas[t].some((l) => chaveDe(l) === chaveDe(linha))) {
        throw new Error(`duplicate key value violates unique constraint on "${t}" (${unico.join(", ")})`);
      }
    }
    this.tabelas[t].push(linha);
  }

  private inserir(s: string, a: unknown[]): number {
    const m = /^INSERT INTO "(\w+)" \(([^)]*)\) VALUES \((.*)\)$/.exec(s);
    if (!m || !TABELAS.includes(m[1] as Tabela)) throw new Error(`INSERT não emulado neste teste: ${s.slice(0, 120)}`);
    const t = m[1] as Tabela;
    const colunas = m[2].split(",").map((c) => c.trim().replace(/"/g, ""));
    const valores = dividirValores(m[3]);
    if (colunas.length !== valores.length) throw new Error(`INSERT com ${colunas.length} colunas e ${valores.length} valores em "${t}"`);
    const agora = new Date(Date.now() + this.seq++);
    const linha: Linha = t === "NfeEmitida" ? { ...NFE_EMITIDA_PADRAO, createdAt: agora } : { createdAt: agora, updatedAt: agora };
    colunas.forEach((c, i) => {
      const v = valores[i];
      const param = /^\$(\d+)(?:::(\w+))?$/.exec(v);
      if (param) {
        const valor = a[Number(param[1]) - 1];
        if (param[2] === "jsonb") {
          if (typeof valor !== "string") throw new Error(`jsonb "${c}" de "${t}" recebeu ${typeof valor}, não texto JSON`);
          JSON.parse(valor);
        }
        linha[c] = valor === undefined ? null : valor;
      } else if (/^'.*'$/.test(v)) {
        linha[c] = v.slice(1, -1);
      } else if (/^NOW\(\)$/i.test(v)) {
        linha[c] = agora;
      } else {
        throw new Error(`valor de INSERT não emulado: ${v}`);
      }
    });
    if (t === "NfeDevolucao" && linha.confirmadoSemXml == null) linha.confirmadoSemXml = false;
    this.gravar(t, linha);
    return 1;
  }

  private executar(sql: string, a: unknown[]): Linha[] | number {
    const s = sql.replace(/\s+/g, " ").trim();
    const T = this.tabelas;
    const nota = (id: unknown, userId?: unknown) => T.NfeEmitida.find((n) => n.id === id && (userId === undefined || n.userId === userId));
    const cabecalho = (nfeId: unknown) => T.NfeDevolucao.find((h) => h.nfeId === nfeId);

    if (s.startsWith("INSERT INTO ")) return this.inserir(s, a);
    if (s.startsWith("SELECT pg_advisory_xact_lock(")) return 1;
    if (s.startsWith(`SELECT COUNT(*)::integer AS n FROM "NfeEmitida" WHERE "userId"=$1 AND "status"='DRAFT'`)) {
      return [{ n: T.NfeEmitida.filter((n) => n.userId === a[0] && n.status === "DRAFT").length }];
    }
    if (s.startsWith(`SELECT "status" FROM "NfeEmitida" WHERE "userId"=$1 AND "id"=$2 FOR UPDATE`)) {
      const n = nota(a[1], a[0]);
      return n ? [{ status: n.status }] : [];
    }
    if (s.startsWith(`SELECT n.*, COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i."numero") FROM "NfeItem" i WHERE i."nfeId"=n."id"),'[]'::jsonb) AS itens FROM "NfeEmitida" n WHERE n."userId"=$1 AND n."id"=$2`)) {
      const n = nota(a[1], a[0]);
      if (!n) return [];
      const itens = T.NfeItem.filter((i) => i.nfeId === n.id).sort((x, y) => Number(x.numero) - Number(y.numero)).map((i) => this.ler("NfeItem", i, true));
      return [{ ...this.ler("NfeEmitida", n, false), itens }];
    }
    if (s.startsWith(`SELECT * FROM "NfeDevolucao" WHERE "userId"=$1 AND "nfeId"=$2`)) {
      return T.NfeDevolucao.filter((h) => h.userId === a[0] && h.nfeId === a[1]).map((h) => this.ler("NfeDevolucao", h, false));
    }
    if (s.startsWith(`SELECT * FROM "NfeDevolucaoItem" WHERE "userId"=$1 AND "devolucaoNfeId"=$2 ORDER BY "ordem"`)) {
      return T.NfeDevolucaoItem.filter((d) => d.userId === a[0] && d.devolucaoNfeId === a[1])
        .sort((x, y) => Number(x.ordem) - Number(y.ordem)).map((d) => this.ler("NfeDevolucaoItem", d, false));
    }
    if (s.includes(`FROM "NfeDevolucaoItem" d JOIN "NfeEmitida" n ON n."id"=d."devolucaoNfeId" AND n."userId"=d."userId"`) && s.endsWith(`WHERE d."userId"=$1 AND d."chaveAcessoOriginal"=$2`)) {
      return T.NfeDevolucaoItem.filter((d) => d.userId === a[0] && d.chaveAcessoOriginal === a[1]).flatMap((d) => {
        const n = nota(d.devolucaoNfeId, d.userId);
        if (!n) return [];
        return [{
          chave: d.chaveAcessoOriginal, nItem: d.nItemOriginal, quantidade: String(d.quantidade), statusDevolucao: n.status, devolucaoNfeId: d.devolucaoNfeId,
          quantidadeOriginal: d.quantidadeOriginal == null ? null : String(d.quantidadeOriginal), fonteDevolucao: cabecalho(d.devolucaoNfeId)?.fonte ?? null,
          numeroDevolucao: n.numero, serieDevolucao: n.serie, criadaEm: n.createdAt,
        }];
      });
    }
    if (s.startsWith(`SELECT n."id" FROM "NfeEmitida" n JOIN "NfeDevolucaoItem" d ON d."devolucaoNfeId"=n."id"`)) {
      const comTipo = s.includes(`h."tipo"=$3`);
      const abertas = T.NfeEmitida.filter((n) => n.userId === a[0] && ["DRAFT", "REJECTED"].includes(String(n.status))
        && T.NfeDevolucaoItem.some((d) => d.devolucaoNfeId === n.id && d.userId === a[0] && d.chaveAcessoOriginal === a[1])
        && (!comTipo || cabecalho(n.id)?.tipo === a[2]))
        .sort((x, y) => (y.updatedAt as Date).getTime() - (x.updatedAt as Date).getTime());
      return abertas.slice(0, 1).map((n) => ({ id: n.id }));
    }
    if (s.startsWith(`SELECT regexp_replace("chaveAcesso",'[^0-9]','','g') AS "chaveAcesso","status","ambiente" FROM "NfeEmitida"`)) {
      const chaves = (a[1] as string[]).map(digitos);
      return T.NfeEmitida.filter((n) => n.userId === a[0] && n.chaveAcesso && chaves.includes(digitos(n.chaveAcesso)))
        .map((n) => ({ chaveAcesso: digitos(n.chaveAcesso), status: n.status, ambiente: n.ambiente }));
    }
    if (s.startsWith(`DELETE FROM "NfeItem" WHERE "nfeId"=$1 AND EXISTS(SELECT 1 FROM "NfeEmitida" WHERE "id"=$1 AND "userId"=$2)`)) {
      if (!nota(a[0], a[1])) return 0;
      const antes = T.NfeItem.length;
      T.NfeItem = T.NfeItem.filter((i) => i.nfeId !== a[0]);
      return antes - T.NfeItem.length;
    }
    if (s.startsWith(`DELETE FROM "NfeDevolucaoItem" WHERE "devolucaoNfeId"=$1 AND "userId"=$2`)) {
      const antes = T.NfeDevolucaoItem.length;
      T.NfeDevolucaoItem = T.NfeDevolucaoItem.filter((d) => !(d.devolucaoNfeId === a[0] && d.userId === a[1]));
      return antes - T.NfeDevolucaoItem.length;
    }
    if (s.startsWith(`UPDATE "NfeEmitida" SET "status"='DRAFT',"totaisJson"=NULL,"updatedAt"=NOW() WHERE "id"=$1 AND "userId"=$2`)) {
      const n = nota(a[0], a[1]);
      if (!n) return 0;
      Object.assign(n, { status: "DRAFT", totaisJson: null, updatedAt: new Date(Date.now() + this.seq++) });
      return 1;
    }
    if (s.startsWith(`UPDATE "NfeDevolucao" SET "escopoSolicitado"=COALESCE($3,"escopoSolicitado")`) && s.includes(`WHERE "nfeId"=$1 AND "userId"=$2`)) {
      const h = T.NfeDevolucao.find((x) => x.nfeId === a[0] && x.userId === a[1]);
      if (!h) return 0;
      Object.assign(h, { escopoSolicitado: a[2] ?? h.escopoSolicitado, updatedAt: new Date(Date.now() + this.seq++) });
      return 1;
    }
    if (s.startsWith(`UPDATE "NfeDevolucao" SET "devolvidaAposEntrega"=CASE WHEN $3 THEN $4 ELSE "devolvidaAposEntrega" END,"escopoSolicitado"=COALESCE($5,"escopoSolicitado")`) && s.includes(`WHERE "userId"=$1 AND "nfeId"=$2`)) {
      const h = T.NfeDevolucao.find((x) => x.userId === a[0] && x.nfeId === a[1]);
      if (!h) return 0;
      Object.assign(h, { devolvidaAposEntrega: a[2] ? a[3] : h.devolvidaAposEntrega, escopoSolicitado: a[4] ?? h.escopoSolicitado, updatedAt: new Date(Date.now() + this.seq++) });
      return 1;
    }
    if (s.startsWith(`SELECT 1 FROM "NfeAuditLog" WHERE "userId"=$1 AND "nfeId"=$2 AND "evento"=$3`)) {
      return T.NfeAuditLog.filter((l) => l.userId === a[0] && l.nfeId === a[1] && l.evento === a[2]).slice(0, 1).map(() => ({ "?column?": 1 }));
    }
    throw new Error(`SQL não emulado neste teste (o repositório mudou? emule o novo comando): ${s.slice(0, 160)}`);
  }
}

// ─────────────────────────── a DLS, a tela e a emissão ───────────────────────────

function configDls() {
  return makeConfig({
    id: CFC, userId: USER, cnpj: CNPJ_DLS, razaoSocial: "DLS AUTO PECAS LTDA", nomeFantasia: "DLS AUTO PECAS", inscricaoEstadual: "261234567",
    regimeTributario: "SIMPLES", ambiente: "PRODUCAO", cep: "89201000", logradouro: "RUA DAS PECAS", numero: "200", bairro: "CENTRO",
    municipio: "JOINVILLE", codMunicipio: "4209102", uf: "SC", providerName: "SEFAZ_DIRECT", serieNfe: 1, isDefault: true,
  });
}

/** Uma DLS nova: banco vazio, o caso de uso com o repositório de verdade por cima dele. */
function dls() {
  const banco = new BancoEmMemoria();
  const config = configDls();
  const configs = {
    findByIdForUser: async (id: string, userId: string) => (id === config.id && userId === USER ? config : null),
    findByUserId: async (userId: string) => (userId === USER ? config : null),
  };
  const repo = new NfeDevolucaoRepository(banco as never);
  const uc = new NfeDevolucaoUseCase(repo, configs as never, {} as never);
  /** O que cada tela manda, passando pelo MESMO parser da rota. */
  const tela = {
    async previa(corpo: Record<string, unknown>) {
      const p = parseManualBody(corpo);
      if (!p.ok) throw new Error("400 do parser: " + JSON.stringify(p.erros));
      return uc.previaManual(USER, p.value);
    },
    async criar(corpo: Record<string, unknown>) {
      const p = parseManualBody(corpo);
      if (!p.ok) throw new Error("400 do parser: " + JSON.stringify(p.erros));
      return uc.manual(USER, ATOR, p.value);
    },
    async responderEntrega(id: string, entregue: boolean) {
      const p = parseAtualizarCabecalhoBody({ devolvidaAposEntrega: entregue });
      if (!p.ok) throw new Error("400 do parser: " + JSON.stringify(p.erros));
      return uc.cabecalho(USER, ATOR, id, p.value);
    },
    async salvarItens(id: string, itens: Array<Record<string, unknown>>): Promise<DevolucaoDetalhe> {
      const p = parseAtualizarItensBody({ itens });
      if (!p.ok) throw new Error("400 do parser: " + JSON.stringify(p.erros));
      return uc.itens(USER, ATOR, id, p.value);
    },
    detalhe: (id: string) => uc.detalhe(USER, id),
  };
  return { banco, config, repo, uc, tela };
}
type Dls = ReturnType<typeof dls>;

const XML_DISAUTO = xmlDaCompra(NOTA_DISAUTO, { nNF: 852899, tpAmb: "1" });
const corpoXml = (xml: string, itens?: Array<{ nItem: number; quantidade: number }>) => ({
  companyFiscalConfigId: CFC, tipo: "COMPRA_SAIDA", xmlOriginal: xml, ...(itens ? { itens } : {}),
});

/** Um item no corpo do PUT …/devolucao/itens, como a tela monta. */
const item = (nItem: number, extra: Record<string, unknown> = {}, ch = CHAVE_DISAUTO) => ({ chaveAcesso: ch, nItem, quantidade: 1, cfop: "5202", ...extra });
/** O que `overrideComIcms` manda com "900" escolhido e a caixa em 12 — a alíquota da compra, que a caixa já traz preenchida (ela confere, não digita). */
const ICMS_900_DA_COMPRA = { icms: { csosn: "900", cst: null, pICMS: 12 } };
/** O que `overrideComPisCofins` manda com "49" escolhido (a caixa mostra 0). */
const PIS_COFINS_49 = { pis: { cst: "49", p: 0 }, cofins: { cst: "49", p: 0 } };

/**
 * O caminho da DLS: importa o XML, escolhe os itens 5 e 6, responde a entrega, e no
 * editor salva cada passo como a tela salva — CFOP (passo "Produtos"), depois o ICMS,
 * depois SÓ o PIS/COFINS com a caixinha "Revisei".
 */
async function devolverItens5e6(o: { xml?: string; ch?: string } = {}) {
  const d = dls();
  const xml = o.xml ?? XML_DISAUTO;
  const ch = o.ch ?? CHAVE_DISAUTO;
  const previa = await d.tela.previa(corpoXml(xml));
  const criado = await d.tela.criar(corpoXml(xml, [{ nItem: 5, quantidade: 1 }, { nItem: 6, quantidade: 1 }]));
  const id = criado.draftId;
  const aoCriar = await d.tela.detalhe(id);
  await d.tela.responderEntrega(id, true);
  const comCfop = await d.tela.salvarItens(id, [item(5, { confirmarTributacao: false }, ch), item(6, { confirmarTributacao: false }, ch)]);
  const comIcms = await d.tela.salvarItens(id, [item(5, { tributacao: ICMS_900_DA_COMPRA }, ch), item(6, { tributacao: ICMS_900_DA_COMPRA }, ch)]);
  const final = await d.tela.salvarItens(id, [
    item(5, { tributacao: PIS_COFINS_49, confirmarTributacao: true }, ch),
    item(6, { tributacao: PIS_COFINS_49, confirmarTributacao: true }, ch),
  ]);
  return { ...d, previa, criado, id, aoCriar, comCfop, comIcms, final };
}

/** A validação do emitente e do rascunho que o orquestrador V2 roda (`hooks.validar`) antes do claim. */
const validarComoAEmissao = (draft: NfeDraftResponse, config: CompanyFiscalConfig) =>
  (NfeEmissionUseCase.prototype as unknown as { validate(d: NfeDraftResponse, c: CompanyFiscalConfig): void }).validate(draft, config);

/**
 * A emissão, sem assinatura e sem rede: o que o orquestrador V2 faz antes de
 * transmitir — `contextoEmissao` (que recusa o que não pode sair), a validação do
 * rascunho, `calcularDevolucao` sobre a linha da nota (NfeEmitida + NfeItem, as
 * mesmas colunas que o `findNfeById` lê) e o build com o número reservado.
 */
async function montarXml(d: Dls, id: string) {
  const { dados, contexto } = await d.uc.contextoEmissao(USER, id);
  validarComoAEmissao(dados.nota, d.config);
  const calculada = calcularDevolucao(dados.nota, contexto);
  const built = new NfeXmlBuilderSefazService().build({
    draft: { ...calculada, numero: NUMERO_DEVOLUCAO, ambiente: d.config.ambiente, companyFiscalConfigId: d.config.id },
    config: d.config, numero: NUMERO_DEVOLUCAO, cNF: CNF, dhEmi: DH_EMI, tpEmis: 1, devolucao: contexto,
  });
  const nfe = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(built.xml).NFe.infNFe;
  return { nfe, xml: built.xml, chaveAcesso: built.chaveAcesso, contexto };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type No = any;
const lista = (x: No): No[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

async function erroDe(p: Promise<unknown>): Promise<DevolucaoError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DevolucaoError) return e;
    throw e;
  }
  throw new Error("esperava a recusa, e a chamada passou");
}

beforeEach(() => {
  stubFlags();
  // Produção antes de 05/10: referência por NOTA (o bloco ITEM abaixo muda a data).
  vi.stubEnv("NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE", "2099-01-01");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────── o caminho que tem de sair ───────────────────────────

describe("devolução de COMPRA da DLS (Simples) à DISAUTO (regime normal): do XML do fornecedor à nota montada", () => {
  it("importar: a prévia lê os 6 itens da compra; criar com os itens 5 e 6 grava só eles, sem herdar o PIS do regime normal", async () => {
    const r = await devolverItens5e6();
    expect(r.previa).toMatchObject({ chaveAcesso: CHAVE_DISAUTO, numero: 852899, serie: 1, emitenteCnpjCpf: CNPJ_DISAUTO, rascunhoAberto: null });
    expect(r.previa.itens.map((i) => [i.nItem, i.codigo, i.quantidadeOriginal, i.disponivel, i.cfopOriginal])).toEqual([
      [1, "11111-1", 3, 3, "5403"], [2, "22222-2", 2, 2, "5102"], [3, "33333-3", 1, 1, "5102"],
      [4, "44444-4", 4, 4, "5102"], [5, "33603-3", 1, 1, "5102"], [6, "24171-7", 1, 1, "5102"],
    ]);
    expect(r.previa.itens[4].cfopOpcoes).toContain("5202");
    expect(r.criado.reutilizado).toBe(false);
    // Um segundo clique em "Criar" abre o MESMO rascunho (K13), pela consulta real do repositório.
    expect(await r.tela.criar(corpoXml(XML_DISAUTO, [{ nItem: 5, quantidade: 1 }]))).toEqual({ draftId: r.id, reutilizado: true });
    expect(r.banco.linhas("NfeEmitida")).toHaveLength(1);

    // Gravado no banco: a nota de devolução, o cabeçalho e as duas peças.
    const [nota] = r.banco.linhas("NfeEmitida");
    expect(nota).toMatchObject({
      id: r.id, userId: USER, companyFiscalConfigId: CFC, ambiente: "PRODUCAO", modelo: "55", serie: 1, status: "DRAFT",
      tipoOperacao: "SAIDA", finalidade: "DEVOLUCAO", destinoOperacao: "INTERNA", naturezaOperacao: "DEVOLUCAO DE COMPRA",
      pagamentosJson: [{ meio: "SEM_PAGAMENTO", valor: 0 }], emittedByUserId: ATOR,
    });
    expect(nota.numero as number).toBeLessThan(0); // rascunho não segura número fiscal
    expect(nota.destinatarioJson).toMatchObject({ tipoPessoa: "PJ", cpfCnpj: CNPJ_DISAUTO, inscricaoEstadual: "258272414", uf: "SC", codMunicipio: "4209102" });
    const [cab] = r.banco.linhas("NfeDevolucao");
    expect(cab).toMatchObject({ nfeId: r.id, tipo: "COMPRA_SAIDA", fonte: "XML_IMPORTADO", indFinal: "0", confirmadoSemXml: false, escopoSolicitado: "PARCIAL" });
    expect((cab.origensJson as Array<Record<string, unknown>>)[0]).toMatchObject({ chaveAcesso: CHAVE_DISAUTO, crtOriginal: "3", idDest: 1, emitenteCnpjCpf: CNPJ_DISAUTO });

    // Ao criar: só as peças 5 e 6, sem CFOP (5102 do fornecedor não diz o da devolução: ela escolhe).
    expect(r.aoCriar.itens.map((i) => [i.ordem, i.nItem, i.codigo, i.quantidade, i.cfop, i.quantidadeOriginal])).toEqual([
      [1, 5, "33603-3", 1, "", 1], [2, 6, "24171-7", 1, "", 1],
    ]);
    expect(r.aoCriar.devolvidaAposEntrega).toBeNull();
    // PIS 01 do fornecedor: o código vem (e é recusado), a alíquota de 1,65% NÃO vem.
    const i5 = r.aoCriar.itens[0];
    expect(i5.tributacao.pis).toEqual({ cst: "01", vBC: 0, p: 0, v: 0 });
    expect(i5.tributacao.cofins).toEqual({ cst: "01", vBC: 0, p: 0, v: 0 });
    expect(i5.referenciaOriginal?.frases.pis).toBe("Na nota do fornecedor: PIS CST 01 · base R$ 108,73 · 1,65% · R$ 1,79.");
    // Nada sai assim: a pergunta da entrega, o CFOP, a revisão, o CST de ICMS do fornecedor e o PIS 01.
    expect(r.aoCriar.podeEmitir).toBe(false);
    expect(r.aoCriar.issues.map((i) => i.code)).toEqual(expect.arrayContaining([
      "ESCOLHA_PENDENTE", "CFOP_ESCOLHA_PENDENTE", "TRIBUTACAO_REVISAO_PENDENTE", "TRIBUTACAO_REGIME_INCOMPATIVEL", "PIS_COFINS_REGIME_INCOMPATIVEL",
    ]));
  });

  it("ajustar: CFOP 5202, CSOSN 900 com a base e a alíquota da compra, PIS/COFINS 49 — salvar só o PIS não desfaz o ICMS, e a devolução fica pronta", async () => {
    const r = await devolverItens5e6();
    expect(r.comCfop.itens.map((i) => i.cfop)).toEqual(["5202", "5202"]);

    // Depois do ICMS: 900 com a base DA COMPRA (vem sozinha) e os 12% da compra (a caixa já vem preenchida com a alíquota gravada da compra; ela confere e salva).
    const esperadoIcms = (c: ItemCompra) => ({ tag: "ICMSSN900", csosn: "900", cst: null, orig: 0, modBC: "3", vBC: c.icms.vBC, pICMS: 12, vICMS: c.icms.vICMS });
    expect(r.comIcms.itens.map((i) => i.tributacao.icms)).toEqual([esperadoIcms(BOMBA_DAGUA), esperadoIcms(BOMBA_OLEO)]);

    // Depois do PUT só com PIS/COFINS: o ICMS gravado CONTINUA (hotfix af1cdc66).
    expect(r.final.itens.map((i) => i.tributacao.icms)).toEqual([esperadoIcms(BOMBA_DAGUA), esperadoIcms(BOMBA_OLEO)]);
    for (const i of r.final.itens) {
      expect(i.tributacao.pis).toEqual({ cst: "49", vBC: 0, p: 0, v: 0 });
      expect(i.tributacao.cofins).toEqual({ cst: "49", vBC: 0, p: 0, v: 0 });
      expect(i.tributacao).toMatchObject({ fonte: "USUARIO", confirmada: true, ipiDevol: null });
      // A base do 900 é a que a nota do fornecedor mostra ao lado do campo.
      expect(i.tributacao.icms.vBC).toBe(i.referenciaOriginal?.icms?.vBC);
      expect(i.tributacao.icms.vICMS).toBe(i.referenciaOriginal?.icms?.vICMS);
    }

    // O banco guardou exatamente o que a tela mostra (jsonb ida e volta).
    const refs = r.banco.linhas("NfeDevolucaoItem");
    expect(refs.map((x) => [x.ordem, x.nItemOriginal, x.quantidade, x.valor, x.quantidadeOriginal])).toEqual([[1, 5, "1.0000", "123.56", "1.0000"], [2, 6, "1.0000", "295.88", "1.0000"]]);
    expect(refs.map((x) => x.tributacaoJson)).toEqual(r.final.itens.map((i) => i.tributacao));
    expect(r.banco.linhas("NfeItem").map((x) => [x.numero, x.codigo, x.cfop, x.quantidade, x.valorTotal])).toEqual([[1, "33603-3", "5202", "1.0000", "123.56"], [2, "24171-7", "5202", "1.0000", "295.88"]]);

    // Pronta: nenhum bloqueio, e nenhum aviso de ICMS a menos (900 a 12% = o da compra).
    expect(r.final.devolvidaAposEntrega).toBe(true);
    expect(r.final.issues.filter((i) => i.severidade === "ERRO")).toEqual([]);
    expect(r.final.issues.map((i) => i.code)).not.toContain("ICMS_COMPRA_A_MENOR");
    expect(r.final.podeEmitir).toBe(true);
    expect(r.final.totais).toMatchObject({ totalProdutos: 419.44, totalDesconto: 0, totalBcIcms: 419.44, totalIcms: 50.34, totalPis: 0, totalCofins: 0, totalIpiDevol: 0, totalNota: 419.44, completo: true, itensPendentes: [] });
  });

  describe.each([
    ["NOTA", "2099-01-01"],
    ["ITEM", "2000-01-01"],
  ] as const)("o XML montado, referência por %s", (modo, desde) => {
    beforeEach(() => {
      vi.stubEnv("NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE", desde);
    });

    it("identificação: devolução (finNFe 4) de saída (tpNF 1), interna, consumidor não final (indFinal 0), sem pagamento (tPag 90) e a referência à nota da DISAUTO", async () => {
      const r = await devolverItens5e6();
      const { nfe, chaveAcesso, contexto } = await montarXml(r, r.id);
      expect(contexto.modoReferencia).toBe(modo);
      expect(nfe.ide).toMatchObject({ mod: "55", serie: "1", nNF: String(NUMERO_DEVOLUCAO), natOp: "DEVOLUCAO DE COMPRA", tpNF: "1", idDest: "1", tpAmb: "1", finNFe: "4", indFinal: "0", indPres: "0" });
      expect(chaveAcesso.slice(6, 20)).toBe(CNPJ_DLS);
      expect(nfe.emit).toMatchObject({ CNPJ: CNPJ_DLS, CRT: "1" });
      expect(nfe.dest).toMatchObject({ CNPJ: CNPJ_DISAUTO, xNome: "DISAUTO DISTRIBUIDORA DE AUTOPECAS LTDA", indIEDest: "1", IE: "258272414" });
      expect(nfe.dest.enderDest).toMatchObject({ cMun: "4209102", UF: "SC" });
      expect(lista(nfe.pag.detPag)).toEqual([{ tPag: "90", vPag: "0.00" }]);
      expect(nfe.cobr).toBeUndefined();
      expect(nfe.transp.modFrete).toBe("9");
      expect(nfe.infAdic.infCpl).toContain(`NF-e 852899 serie 1, chave ${CHAVE_DISAUTO}`);
      const dets = lista(nfe.det);
      if (modo === "NOTA") {
        expect(lista(nfe.ide.NFref)).toEqual([{ refNFe: CHAVE_DISAUTO }]);
        expect(dets.map((d) => d.DFeReferenciado)).toEqual([undefined, undefined]);
      } else {
        expect(nfe.ide.NFref).toBeUndefined();
        expect(dets.map((d) => d.DFeReferenciado)).toEqual([{ chaveAcesso: CHAVE_DISAUTO, nItem: "5" }, { chaveAcesso: CHAVE_DISAUTO, nItem: "6" }]);
      }
    });

    it("itens: CFOP 5202 nos dois, ICMSSN900 com a base, a alíquota e o ICMS da compra, PIS/COFINS 49 zerados, nada de ST nem do grupo do fornecedor", async () => {
      const r = await devolverItens5e6();
      const { nfe, xml } = await montarXml(r, r.id);
      const dets = lista(nfe.det);
      expect(dets.map((d) => d["@_nItem"])).toEqual(["1", "2"]);
      expect(dets.map((d) => [d.prod.cProd, d.prod.CFOP, d.prod.NCM, d.prod.qCom, d.prod.vUnCom, d.prod.vProd])).toEqual([
        ["33603-3", "5202", "84133090", "1.0000", "123.5600", "123.56"],
        ["24171-7", "5202", "84133090", "1.0000", "295.8800", "295.88"],
      ]);
      const daCompra = (c: ItemCompra) => ({ orig: "0", CSOSN: "900", modBC: "3", vBC: f2(c.icms.vBC), pICMS: "12.00", vICMS: f2(c.icms.vICMS) });
      expect(dets.map((d) => d.imposto.ICMS)).toEqual([{ ICMSSN900: daCompra(BOMBA_DAGUA) }, { ICMSSN900: daCompra(BOMBA_OLEO) }]);
      for (const d of dets) {
        expect(d.imposto.PIS).toEqual({ PISOutr: { CST: "49", vBC: "0.00", pPIS: "0.00", vPIS: "0.00" } });
        expect(d.imposto.COFINS).toEqual({ COFINSOutr: { CST: "49", vBC: "0.00", pCOFINS: "0.00", vCOFINS: "0.00" } });
        expect(d.impostoDevol).toBeUndefined();
      }
      expect(JSON.stringify(dets)).not.toMatch(/ICMS00|ICMS10|PISAliq|COFINSAliq|PISNT|vBCST|vICMSST/);
      expect(xml).not.toContain("<cobr>");
    });

    it("totais fecham (vBC, vICMS, vPIS, vCOFINS e vProd = soma dos itens; vNF pela regra W16) e são os que a tela mostrou antes de emitir", async () => {
      const r = await devolverItens5e6();
      const { nfe } = await montarXml(r, r.id);
      const dets = lista(nfe.det);
      const tot = nfe.total.ICMSTot;
      expect(tot).toMatchObject({
        vBC: "419.44", vICMS: "50.34", vICMSDeson: "0.00", vBCST: "0.00", vST: "0.00", vFCPST: "0.00", vProd: "419.44", vFrete: "0.00", vSeg: "0.00",
        vDesc: "0.00", vII: "0.00", vIPI: "0.00", vIPIDevol: "0.00", vPIS: "0.00", vCOFINS: "0.00", vOutro: "0.00", vNF: "419.44",
      });
      const soma = (fn: (d: No) => string) => r2(dets.reduce((n, d) => n + Number(fn(d)), 0)).toFixed(2);
      expect(soma((d) => d.prod.vProd)).toBe(tot.vProd);
      expect(soma((d) => d.imposto.ICMS.ICMSSN900.vBC)).toBe(tot.vBC);
      expect(soma((d) => d.imposto.ICMS.ICMSSN900.vICMS)).toBe(tot.vICMS);
      expect(soma((d) => d.imposto.PIS.PISOutr.vPIS)).toBe(tot.vPIS);
      expect(soma((d) => d.imposto.COFINS.COFINSOutr.vCOFINS)).toBe(tot.vCOFINS);
      const w16 = ["vProd", "vST", "vFCPST", "vFrete", "vSeg", "vOutro", "vII", "vIPI", "vIPIDevol"].reduce((n, k) => n + Number(tot[k]), 0)
        - Number(tot.vDesc) - Number(tot.vICMSDeson);
      expect(r2(w16).toFixed(2)).toBe(tot.vNF);
      // A tela mostrou os MESMOS números antes de emitir.
      expect(r.final.totais?.totalNota.toFixed(2)).toBe(tot.vNF);
      expect(r.final.totais?.totalIcms.toFixed(2)).toBe(tot.vICMS);
      expect(r.final.totais?.totalBcIcms.toFixed(2)).toBe(tot.vBC);
      expect(r.final.totais?.totalProdutos.toFixed(2)).toBe(tot.vProd);
    });
  });

  it("proporção: devolvendo 1 de 2 unidades, o 900 leva a metade da base e do ICMS da compra (e a tela diz 'na proporção de 1 de 2')", async () => {
    const BOMBA_OLEO_2: ItemCompra = { ...BOMBA_OLEO, qCom: 2, icms: { cst: "00", vBC: 591.76, vICMS: 71.01 } };
    const ch = chave(CNPJ_DISAUTO, 852900);
    const r = await devolverItens5e6({ xml: xmlDaCompra([LUBRAX, FILTRO, CORREIA, VELA, BOMBA_DAGUA, BOMBA_OLEO_2], { nNF: 852900, tpAmb: "1" }), ch });
    const i6 = r.final.itens[1];
    expect(i6).toMatchObject({ nItem: 6, quantidade: 1, quantidadeOriginal: 2, valor: 295.88 });
    expect(i6.tributacao.icms).toMatchObject({ tag: "ICMSSN900", vBC: 295.88, pICMS: 12, vICMS: 35.51 });
    expect(i6.referenciaOriginal?.frases.icms).toBe("Na nota do fornecedor: CST 00 · base R$ 295,88 · 12% · ICMS R$ 35,51 (na proporção de 1 de 2).");
    // devolve metade da compra: o saldo do item continua com 1 para uma próxima devolução
    expect(r.final.escopo).toBe("PARCIAL");
    const { nfe } = await montarXml(r, r.id);
    const d6 = lista(nfe.det)[1];
    expect(d6.prod).toMatchObject({ qCom: "1.0000", vProd: "295.88" });
    expect(d6.imposto.ICMS.ICMSSN900).toMatchObject({ vBC: "295.88", pICMS: "12.00", vICMS: "35.51" });
    expect(lista(nfe.ide.NFref)).toEqual([{ refNFe: ch }]);
    expect(nfe.total.ICMSTot).toMatchObject({ vBC: "419.44", vICMS: "50.34", vNF: "419.44" });
  });

  it("desconto na linha da compra: a devolução leva o mesmo desconto, a base do 900 é a líquida da compra, e vNF = produtos − desconto (na tela e no XML)", async () => {
    const COM_DESCONTO: ItemCompra = { ...BOMBA_DAGUA, vDesc: 3.56, icms: { cst: "00", vBC: 120, vICMS: 14.4 }, vBCPis: 105.6 };
    const ch = chave(CNPJ_DISAUTO, 852901);
    const r = await devolverItens5e6({ xml: xmlDaCompra([LUBRAX, FILTRO, CORREIA, VELA, COM_DESCONTO, BOMBA_OLEO], { nNF: 852901, tpAmb: "1" }), ch });
    expect(r.final.itens[0].tributacao.icms).toMatchObject({ tag: "ICMSSN900", vBC: 120, pICMS: 12, vICMS: 14.4 });
    expect(r.final.issues.map((i) => i.code)).not.toContain("ICMS_COMPRA_A_MENOR");
    expect(r.final.totais).toMatchObject({ totalProdutos: 419.44, totalDesconto: 3.56, totalBcIcms: 415.88, totalIcms: 49.91, totalNota: 415.88, completo: true });
    const { nfe } = await montarXml(r, r.id);
    const [d5] = lista(nfe.det);
    expect(d5.prod).toMatchObject({ vProd: "123.56", vDesc: "3.56" });
    expect(d5.imposto.ICMS.ICMSSN900).toMatchObject({ vBC: "120.00", vICMS: "14.40" });
    const tot = nfe.total.ICMSTot;
    expect(tot).toMatchObject({ vProd: "419.44", vDesc: "3.56", vBC: "415.88", vICMS: "49.91", vNF: "415.88" });
    expect(r.final.totais?.totalNota.toFixed(2)).toBe(tot.vNF);
  });

  it("depois de autorizada, a mesma nota de compra só devolve o que sobrou: nova devolução sem os itens 5 e 6, e o 5 pedido de novo é recusado", async () => {
    const r = await devolverItens5e6();
    const { chaveAcesso } = await montarXml(r, r.id);
    r.banco.autorizar(r.id, NUMERO_DEVOLUCAO, chaveAcesso);

    const previa = await r.tela.previa(corpoXml(XML_DISAUTO));
    expect(previa.rascunhoAberto).toBeNull();
    expect(previa.itens.map((i) => [i.nItem, i.disponivel, i.devolvidaAutorizada])).toEqual([[1, 3, 0], [2, 2, 0], [3, 1, 0], [4, 4, 0], [5, 0, 1], [6, 0, 1]]);

    // Pedir de novo a peça 5, já devolvida: recusa com o item e onde está, e nada é criado.
    const e = await erroDe(r.tela.criar(corpoXml(XML_DISAUTO, [{ nItem: 5, quantidade: 1 }])));
    expect(e.code).toBe("SALDO_INSUFICIENTE");
    expect(e.issues?.map((i) => [i.code, i.severidade])).toEqual([["SALDO_EXCEDIDO", "ERRO"]]);
    expect(e.issues?.[0].mensagem).toContain("33603-3 (item 5 da nota original)");
    expect(e.issues?.[0].mensagem).toContain("1 já devolvido em NF-e autorizada");
    expect(r.banco.linhas("NfeEmitida")).toHaveLength(1);

    // Sem seleção: nasce com o que sobrou (a autorizada não é reaproveitada como rascunho).
    const segunda = await r.tela.criar(corpoXml(XML_DISAUTO));
    expect(segunda.reutilizado).toBe(false);
    expect(segunda.draftId).not.toBe(r.id);
    const d2 = await r.tela.detalhe(segunda.draftId);
    expect(d2.itens.map((i) => [i.nItem, i.quantidade])).toEqual([[1, 3], [2, 2], [3, 1], [4, 4]]);
    // E a peça 5 não entra nela pelo editor.
    const e2 = await erroDe(r.tela.salvarItens(segunda.draftId, [item(2, { quantidade: 2 }), item(5)]));
    expect(e2.code).toBe("SALDO_INSUFICIENTE");
    expect(e2.issues?.[0].mensagem).toContain("não tem mais saldo para devolver (1 já devolvido em NF-e autorizada)");
  });
});

// ─────────────────────────── o que TEM de travar ───────────────────────────

describe("devolução de compra da DLS: os caminhos que têm de travar", () => {
  async function comEntrega(itens: number[]) {
    const d = dls();
    const previa = await d.tela.previa(corpoXml(XML_DISAUTO));
    const { draftId: id } = await d.tela.criar(corpoXml(XML_DISAUTO, itens.map((nItem) => ({ nItem, quantidade: 1 }))));
    await d.tela.responderEntrega(id, true);
    return { ...d, previa, id };
  }

  it("item 1 com ICMS-ST: salva com 'Revisei' marcado, mas não emite — diz o ST que ficaria de fora e 'combine com a contadora'; sem o item, emite", async () => {
    const d = await comEntrega([1, 5, 6]);
    const cfopSt = "5411"; // devolução de compra com ST
    expect(d.previa.itens[0].cfopOpcoes).toContain(cfopSt);
    const tudo = { ...ICMS_900_DA_COMPRA, ...PIS_COFINS_49 };
    const salvo = await d.tela.salvarItens(d.id, [
      item(1, { cfop: cfopSt, tributacao: tudo, confirmarTributacao: true }),
      item(5, { tributacao: tudo, confirmarTributacao: true }),
      item(6, { tributacao: tudo, confirmarTributacao: true }),
    ]);
    expect(salvo.itens[0]).toMatchObject({ nItem: 1, quantidade: 1, quantidadeOriginal: 3 });
    expect(salvo.itens[0].tributacao.confirmada).toBe(true); // a caixinha foi marcada...
    expect(salvo.podeEmitir).toBe(false); // ...e não libera
    const erros = salvo.issues.filter((i) => i.severidade === "ERRO");
    expect(erros).toEqual([{
      code: "ICMS_ST_NAO_DEVOLVIDO", severidade: "ERRO", ordem: 1,
      mensagem: "Item 1: a nota original cobrou ICMS-ST desta peça — R$ 6,68 na quantidade devolvida, e o Dexo ainda não devolve ICMS-ST: esse valor ficaria fora da nota. Combine com a contadora como devolver este item.",
    }]);

    // A emissão recusa ANTES de reservar número, com a mesma pendência.
    const e = await erroDe(d.uc.contextoEmissao(USER, d.id));
    expect(e.code).toBe("DEVOLUCAO_INVALIDA");
    expect(e.httpStatus).toBe(422);
    expect(e.issues?.filter((i) => i.severidade === "ERRO").map((i) => [i.ordem, i.code])).toEqual([[1, "ICMS_ST_NAO_DEVOLVIDO"]]);
    // E nem com o contexto forçado o cálculo deixa a nota sair sem o ST.
    const dados = await d.repo.get(USER, d.id);
    expect(() => calcularDevolucao(dados!.nota, { modoReferencia: "NOTA", indFinal: "0", refs: dados!.refs })).toThrow("Tributação da devolução incompleta");

    // A saída: tirar o item 1. As peças 5 e 6 continuam com o que ela ajustou.
    const sem1 = await d.tela.salvarItens(d.id, [item(5, { confirmarTributacao: true }), item(6, { confirmarTributacao: true })]);
    expect(sem1.itens.map((i) => [i.ordem, i.nItem, i.tributacao.icms.csosn, i.tributacao.pis.cst])).toEqual([[1, 5, "900", "49"], [2, 6, "900", "49"]]);
    expect(sem1.podeEmitir).toBe(true);
    const { nfe } = await montarXml(d, d.id);
    expect(lista(nfe.det).map((x) => x.prod.cProd)).toEqual(["33603-3", "24171-7"]);
    expect(nfe.total.ICMSTot).toMatchObject({ vST: "0.00", vNF: "419.44" });
  });

  it("PIS/COFINS 01 do fornecedor: herdado, bloqueia mesmo com 'Revisei'; escolhido à mão, é recusado na hora (422, com o motivo) e nada é gravado", async () => {
    const d = await comEntrega([5, 6]);
    const herdado = await d.tela.salvarItens(d.id, [
      item(5, { tributacao: ICMS_900_DA_COMPRA, confirmarTributacao: true }),
      item(6, { tributacao: ICMS_900_DA_COMPRA, confirmarTributacao: true }),
    ]);
    expect(herdado.itens[0].tributacao.pis).toEqual({ cst: "01", vBC: 0, p: 0, v: 0 });
    expect(herdado.itens[1].tributacao.pis).toEqual({ cst: "04", vBC: 0, p: 0, v: 0 });
    expect(herdado.podeEmitir).toBe(false);
    const pendencias = herdado.issues.filter((i) => i.severidade === "ERRO");
    expect(pendencias.map((i) => [i.ordem, i.code])).toEqual([[1, "PIS_COFINS_REGIME_INCOMPATIVEL"]]); // só o item 5; o 6 é 04
    expect(pendencias[0].mensagem).toContain("a sua empresa é do Simples Nacional");

    const antes = d.banco.linhas("NfeDevolucaoItem");
    const e = await erroDe(d.tela.salvarItens(d.id, [
      item(5, { tributacao: { pis: { cst: "01", p: 1.65 }, cofins: { cst: "01", p: 7.6 } }, confirmarTributacao: true }),
      item(6, { confirmarTributacao: true }),
    ]));
    expect(e.code).toBe("TRIBUTACAO_NAO_SUPORTADA");
    expect(e.httpStatus).toBe(422);
    expect(e.issues?.map((i) => [i.ordem, i.code, i.severidade])).toEqual([
      [1, "PIS_COFINS_REGIME_INCOMPATIVEL", "ERRO"], [1, "PIS_COFINS_REGIME_INCOMPATIVEL", "ERRO"],
    ]);
    expect(e.issues?.[0].mensagem).toMatch(/^Item 1: PIS: O CST 01 é de empresa do regime normal/);
    expect(e.issues?.[1].mensagem).toMatch(/^Item 1: COFINS: O CST 01 é de empresa do regime normal/);
    expect(d.banco.linhas("NfeDevolucaoItem")).toEqual(antes);

    const naEmissao = await erroDe(d.uc.contextoEmissao(USER, d.id));
    expect(naEmissao.code).toBe("DEVOLUCAO_INVALIDA");
    expect(naEmissao.issues?.map((i) => i.code)).toContain("PIS_COFINS_REGIME_INCOMPATIVEL");

    // Com o 49, sai.
    const ok = await d.tela.salvarItens(d.id, [item(5, { tributacao: PIS_COFINS_49, confirmarTributacao: true }), item(6, { confirmarTributacao: true })]);
    expect(ok.podeEmitir).toBe(true);
    const { nfe } = await montarXml(d, d.id);
    expect(lista(nfe.det).map((x) => Object.keys(x.imposto.PIS))).toEqual([["PISOutr"], ["PISNT"]]);
  });

  it("CSOSN 500 no item 5: AVISO de que declara uma ST que a compra não teve, e de ICMS a menos que o da compra (Res. CGSN 140/2018, art. 59) — não bloqueia", async () => {
    const d = await comEntrega([5, 6]);
    const salvo = await d.tela.salvarItens(d.id, [
      item(5, { tributacao: { icms: { csosn: "500", cst: null }, ...PIS_COFINS_49 }, confirmarTributacao: true }),
      item(6, { tributacao: { ...ICMS_900_DA_COMPRA, ...PIS_COFINS_49 }, confirmarTributacao: true }),
    ]);
    expect(salvo.itens[0].tributacao.icms).toMatchObject({ tag: "ICMSSN500", csosn: "500", vBC: 0, vICMS: 0 });
    const doItem5 = salvo.issues.filter((i) => i.ordem === 1);
    expect(doItem5.map((i) => [i.code, i.severidade]).sort()).toEqual([["ICMS_500_SEM_ST", "AVISO"], ["ICMS_COMPRA_A_MENOR", "AVISO"]]);
    const aviso500 = doItem5.find((i) => i.code === "ICMS_500_SEM_ST")!;
    expect(aviso500.mensagem).toBe("Item 1: o CSOSN 500 declara que o ICMS já foi cobrado antes por substituição tributária, mas a compra deste item não teve ST (código 00 na nota do fornecedor) — confirme o código com a contadora.");
    const aMenor = doItem5.find((i) => i.code === "ICMS_COMPRA_A_MENOR")!;
    expect(aMenor.mensagem).toContain("a nota de compra destacou R$ 14,83 de ICMS nesta quantidade (base R$ 123,56), e a devolução vai com R$ 0,00 — ficam de fora R$ 14,83");
    expect(aMenor.mensagem).toContain("Res. CGSN 140/2018, art. 59");
    expect(salvo.issues.filter((i) => i.ordem === 2)).toEqual([]); // o item 6, com o 900 da compra, não avisa nada
    expect(salvo.issues.filter((i) => i.severidade === "ERRO")).toEqual([]);
    expect(salvo.podeEmitir).toBe(true);

    // Aviso não trava a emissão: o item 5 sai no grupo do 500 (sem valores).
    const { nfe } = await montarXml(d, d.id);
    const [d5, d6] = lista(nfe.det);
    expect(d5.imposto.ICMS).toEqual({ ICMSSN500: { orig: "0", CSOSN: "500" } });
    expect(d6.imposto.ICMS.ICMSSN900).toMatchObject({ vBC: "295.88", vICMS: "35.51" });
    expect(nfe.total.ICMSTot).toMatchObject({ vBC: "295.88", vICMS: "35.51", vNF: "419.44" });
  });
});
