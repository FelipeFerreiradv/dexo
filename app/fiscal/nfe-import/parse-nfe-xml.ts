/**
 * Parser PURO de NF-e (modelo 55, leiaute 4.00) para importação de produtos.
 *
 * Entrada: string XML da nota de compra. Saída: `NfeParsedResult` normalizado.
 * Sem dependência de Fastify/Prisma — totalmente unit-testável.
 *
 * Segurança (XXE): rejeitamos qualquer XML com `<!DOCTYPE`/`<!ENTITY>` e
 * configuramos o parser com `processEntities: false`. NF-e legítima nunca traz
 * DOCTYPE, então a checagem elimina XXE e "billion laughs" sem falsos positivos.
 */

import { XMLParser } from "fast-xml-parser";
import type { NfeParsedItem, NfeParsedResult } from "./nfe-import.types";

/** Erro de parsing/validação da NF-e. `statusCode` é usado pela rota para responder 400. */
export class NfeParseError extends Error {
  public readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "NfeParseError";
  }
}

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/** Converte valor textual da NF-e em número, tolerando vírgula decimal. */
const toNum = (v: unknown): number => {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim().replace(",", ".");
  if (s === "") return NaN;
  return Number(s);
};

const asString = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).trim();

const soDigitos = (v: unknown): string => asString(v).replace(/\D/g, "");

/**
 * A data de emissão em `AAAA-MM-DD`.
 *
 * Aceita as duas gerações do leiaute: `dhEmi` do 4.00
 * (`2026-07-15T10:30:00-03:00`) e `dEmi` do 3.10 (`2026-07-15`). O corte é por
 * regex e não por `slice(0,10)` de propósito — um campo preenchido torto vira
 * `undefined` em vez de virar uma data inventada de 10 caracteres.
 */
function dataDeEmissao(ide: Record<string, unknown>): string | undefined {
  const bruto = asString(ide.dhEmi) || asString(ide.dEmi);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(bruto);
  return m ? m[1] : undefined;
}

/**
 * Os 44 dígitos da chave, de `infNFe/@Id`.
 *
 * ⚠️ NÃO CONFERE O DÍGITO VERIFICADOR. Ver a nota em `nfe-import.types.ts`:
 * conferir aqui faria uma nota com chave torta parar de importar produto, que é
 * comportamento que já existia. Aqui só sai a chave quando ela TEM 44 dígitos —
 * qualquer outra coisa vira `undefined`, nunca um pedaço.
 */
function chaveDeAcesso(infNFe: Record<string, unknown>): string | undefined {
  // `attributeNamePrefix: "@_"`, e o valor vem como `NFe3526...` — o prefixo
  // não tem dígito, então extrair só os dígitos já o descarta.
  const digitos = soDigitos(infNFe["@_Id"]);
  return digitos.length === 44 ? digitos : undefined;
}

interface GroupAcc {
  cProd: string;
  cEAN: string;
  xProd: string;
  uCom: string;
  qtySum: number;
  vProdSum: number;
  vUnComFirst: number;
}

export function parseNfeXml(xml: string): NfeParsedResult {
  if (typeof xml !== "string" || xml.trim() === "") {
    throw new NfeParseError("XML vazio ou ausente.");
  }

  // Guard XXE: NF-e válida não tem DOCTYPE nem ENTITY.
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new NfeParseError("XML com DOCTYPE/ENTITY não é permitido.");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false, // mantém códigos (cEAN, NCM) como string e evita perda de precisão
    parseAttributeValue: false,
    processEntities: false, // defesa extra contra expansão de entidades
    removeNSPrefix: true, // tolera namespaces prefixados (nfe:NFe etc.)
    trimValues: true,
  });

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new NfeParseError("XML inválido ou corrompido.");
  }

  // O XML pode vir processado (`nfeProc/NFe/infNFe`) ou cru (`NFe/infNFe`).
  const nfeProc = doc?.nfeProc as Record<string, unknown> | undefined;
  const nfe = (nfeProc?.NFe ?? doc?.NFe) as Record<string, unknown> | undefined;
  const infNFe = nfe?.infNFe as Record<string, unknown> | undefined;
  if (!infNFe) {
    throw new NfeParseError("XML não é uma NF-e reconhecível.");
  }

  // Modelo 55 (campo ide/mod). Se ausente, seguimos (alguns layouts mínimos omitem).
  const ide = (infNFe.ide ?? {}) as Record<string, unknown>;
  const mod = asString(ide.mod);
  if (mod && mod !== "55") {
    throw new NfeParseError(
      `Apenas NF-e modelo 55 é suportada (recebido: modelo ${mod}).`,
    );
  }

  // `det` pode ser objeto único (1 item) ou array (vários).
  const detRaw = infNFe.det;
  const dets: Array<Record<string, unknown>> = Array.isArray(detRaw)
    ? (detRaw as Array<Record<string, unknown>>)
    : detRaw
      ? [detRaw as Record<string, unknown>]
      : [];
  if (dets.length === 0) {
    throw new NfeParseError("Nota sem itens (nenhum <det> encontrado).");
  }

  // Agrupa por (cProd|cEAN|xProd) somando quantidade e valor total.
  const groups = new Map<string, GroupAcc>();
  for (const det of dets) {
    const prod = det?.prod as Record<string, unknown> | undefined;
    if (!prod) continue;

    const cProd = asString(prod.cProd);
    const cEAN = asString(prod.cEAN);
    const xProd = asString(prod.xProd);
    const uCom = asString(prod.uCom);
    const qCom = toNum(prod.qCom);
    const vUnCom = toNum(prod.vUnCom);
    const vProd = toNum(prod.vProd);

    const qty = Number.isFinite(qCom) ? qCom : 0;
    const lineTotal = Number.isFinite(vProd)
      ? vProd
      : Number.isFinite(vUnCom)
        ? vUnCom * qty
        : 0;

    const key = `${cProd}|${cEAN}|${xProd}`;
    const acc = groups.get(key) ?? {
      cProd,
      cEAN,
      xProd,
      uCom,
      qtySum: 0,
      vProdSum: 0,
      vUnComFirst: vUnCom,
    };
    acc.qtySum += qty;
    acc.vProdSum += lineTotal;
    if (!Number.isFinite(acc.vUnComFirst) && Number.isFinite(vUnCom)) {
      acc.vUnComFirst = vUnCom;
    }
    groups.set(key, acc);
  }

  const items: NfeParsedItem[] = [];
  for (const g of groups.values()) {
    const quantity = Math.round(g.qtySum);
    const costPrice =
      g.qtySum > 0 && Number.isFinite(g.vProdSum)
        ? round2(g.vProdSum / g.qtySum)
        : round2(Number.isFinite(g.vUnComFirst) ? g.vUnComFirst : 0);
    items.push({
      groupKey: `${g.cProd}|${g.cEAN}|${g.xProd}`,
      name: g.xProd.slice(0, 60),
      fullName: g.xProd,
      costPrice,
      quantity,
      unit: g.uCom,
      lineTotal: round2(g.vProdSum),
    });
  }

  if (items.length === 0) {
    throw new NfeParseError("Nota sem itens válidos (sem <prod>).");
  }

  const emit = (infNFe.emit ?? {}) as Record<string, unknown>;

  // ⭐ O cabeçalho fiscal. TUDO opcional e nada lança: uma nota sem `Id`, sem
  // `vICMS` ou com data em leiaute que este parser não reconhece continua
  // importando produto exatamente como antes desta linha existir.
  const total = (infNFe.total ?? {}) as Record<string, unknown>;
  const icmsTot = (total.ICMSTot ?? {}) as Record<string, unknown>;
  const vIcms = toNum(icmsTot.vICMS);
  const cnpj = soDigitos(emit.CNPJ);

  return {
    items,
    meta: {
      numero: asString(ide.nNF) || undefined,
      emitName: asString(emit.xNome) || undefined,
      accessKey: chaveDeAcesso(infNFe),
      // 14 dígitos ou nada. Nota de pessoa física traz `CPF` e não `CNPJ`, e
      // devolver um CPF num campo chamado `emitCnpj` seria pior que devolver
      // vazio — quem consome grava em `Scrap.supplierCnpj`.
      emitCnpj: cnpj.length === 14 ? cnpj : undefined,
      serie: asString(ide.serie) || undefined,
      issueDate: dataDeEmissao(ide),
      operationNature: asString(ide.natOp) || undefined,
      icmsValue: Number.isFinite(vIcms) ? round2(vIcms) : undefined,
      itemCount: dets.length,
      groupedCount: items.length,
    },
  };
}
