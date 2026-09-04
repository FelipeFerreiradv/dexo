/**
 * Parser de XML NFe autorizado (`<nfeProc>` ou `<NFe>` solto) para uma
 * estrutura tipada utilizável pela geração de DANFE e auditoria.
 *
 * Usa `fast-xml-parser` com configuração XXE-safe (sem expansão de
 * entidades externas). NÃO valida assinatura nem schema XSD — só extrai
 * dados. Validação fiscal é responsabilidade da SEFAZ.
 */

import { XMLParser } from "fast-xml-parser";

export interface ParsedNfe {
  chaveAcesso: string;
  versao: string;
  ide: ParsedIde;
  emit: ParsedEmit;
  dest: ParsedDest;
  itens: ParsedItem[];
  total: ParsedTotal;
  transp: ParsedTransp | null;
  pag: ParsedPagamento[];
  /** Conteúdo de <infAdic><infCpl> (informações complementares), se houver. */
  infCpl: string | null;
  /** Carregado apenas quando o input é <nfeProc> (NFe já autorizada). */
  protNFe: ParsedProtNFe | null;
}

export interface ParsedIde {
  cUF: number;
  natOp: string;
  mod: string;
  serie: number;
  nNF: number;
  dhEmi: string | null;
  dhSaiEnt: string | null;
  tpNF: "0" | "1";
  tpAmb: "1" | "2";
  finNFe: string;
  tpEmis: number;
  cMunFG: string;
  cDV: string;
}

export interface ParsedEndereco {
  xLgr: string;
  nro: string;
  xCpl: string | null;
  xBairro: string;
  cMun: string;
  xMun: string;
  UF: string;
  CEP: string;
  cPais: string;
  xPais: string;
  fone: string | null;
}

export interface ParsedEmit {
  CNPJ: string | null;
  CPF: string | null;
  xNome: string;
  xFant: string | null;
  IE: string;
  IM: string | null;
  CNAE: string | null;
  CRT: string;
  ender: ParsedEndereco;
}

export interface ParsedDest {
  CNPJ: string | null;
  CPF: string | null;
  idEstrangeiro: string | null;
  xNome: string;
  IE: string | null;
  indIEDest: string;
  email: string | null;
  ender: ParsedEndereco | null;
}

export interface ParsedItem {
  nItem: number;
  cProd: string;
  cEAN: string;
  xProd: string;
  NCM: string;
  CFOP: string;
  uCom: string;
  qCom: number;
  vUnCom: number;
  vProd: number;
  vDesc: number;
  CEST: string | null;
  /** Dump bruto do bloco <imposto> (para inspeção/auditoria). */
  imposto: any;
}

export interface ParsedTotal {
  vBC: number;
  vICMS: number;
  vProd: number;
  vFrete: number;
  vSeg: number;
  vDesc: number;
  vIPI: number;
  vPIS: number;
  vCOFINS: number;
  vOutro: number;
  vNF: number;
}

export interface ParsedVolume {
  qVol: number | null;
  esp: string | null;
  marca: string | null;
  nVol: string | null;
  pesoL: number | null;
  pesoB: number | null;
}

export interface ParsedTransp {
  modFrete: string;
  /** Volumes transportados. Alimentam o quadro do DANFE gerado a partir do XML. */
  vol: ParsedVolume[];
  transporta: {
    CNPJ: string | null;
    CPF: string | null;
    xNome: string | null;
    IE: string | null;
    xEnder: string | null;
    xMun: string | null;
    UF: string | null;
  } | null;
}

export interface ParsedPagamento {
  tPag: string;
  vPag: number;
}

export interface ParsedProtNFe {
  chNFe: string;
  nProt: string;
  dhRecbto: string;
  cStat: number;
  xMotivo: string;
  digVal: string | null;
}

/**
 * Parseia um XML NFe (com ou sem o wrapper `<nfeProc>`). Lança erro
 * descritivo se o XML não bater com o esperado.
 *
 * Aceita também a `<NFe>` "crua" (sem protNFe) — útil para auditoria de
 * rascunhos assinados antes do envio.
 */
export function parseNfeXml(xml: string): ParsedNfe {
  if (!xml || typeof xml !== "string") {
    throw new Error("XML NFe vazio ou invalido");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false, // Mantém todos como string — convertemos onde precisa
    parseAttributeValue: false,
    trimValues: true,
    // Anti-XXE: fast-xml-parser não expande entidades externas, mas reforçamos:
    processEntities: false,
  });

  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw new Error(`Falha ao parsear XML NFe: ${(error as Error).message}`);
  }

  // Navegação: NFe pode estar em <nfeProc><NFe>...</NFe><protNFe>...</protNFe></nfeProc>
  // ou diretamente <NFe>...</NFe>.
  const nfeProc = parsed?.nfeProc;
  const nfeRoot = nfeProc?.NFe ?? parsed?.NFe;
  if (!nfeRoot) {
    throw new Error("XML nao contem <NFe> — verifique o root element");
  }

  const infNFe = nfeRoot.infNFe;
  if (!infNFe) {
    throw new Error("XML NFe sem <infNFe>");
  }

  const infNFeId: string = String(infNFe["@_Id"] ?? "");
  const chaveAcesso = infNFeId.replace(/^NFe/, "");
  const versao = String(infNFe["@_versao"] ?? "");

  const ide = parseIde(infNFe.ide);
  const emit = parseEmit(infNFe.emit);
  const dest = parseDest(infNFe.dest, ide.mod);
  const itens = parseItens(infNFe.det);
  const total = parseTotal(infNFe.total?.ICMSTot);
  const transp = parseTransp(infNFe.transp);
  const pag = parsePag(infNFe.pag);
  const infCpl = infNFe.infAdic?.infCpl ? str(infNFe.infAdic.infCpl) : null;
  const protNFe = nfeProc ? parseProtNFe(nfeProc.protNFe) : null;

  return {
    chaveAcesso,
    versao,
    ide,
    emit,
    dest,
    itens,
    total,
    transp,
    pag,
    infCpl,
    protNFe,
  };
}

function parseIde(ide: any): ParsedIde {
  if (!ide) throw new Error("XML NFe sem <ide>");
  return {
    cUF: toInt(ide.cUF),
    natOp: str(ide.natOp),
    mod: str(ide.mod),
    serie: toInt(ide.serie),
    nNF: toInt(ide.nNF),
    dhEmi: ide.dhEmi ? str(ide.dhEmi) : null,
    dhSaiEnt: ide.dhSaiEnt ? str(ide.dhSaiEnt) : null,
    tpNF: str(ide.tpNF) as "0" | "1",
    tpAmb: str(ide.tpAmb) as "1" | "2",
    finNFe: str(ide.finNFe),
    tpEmis: toInt(ide.tpEmis),
    cMunFG: str(ide.cMunFG),
    cDV: str(ide.cDV),
  };
}

function parseEmit(emit: any): ParsedEmit {
  if (!emit) throw new Error("XML NFe sem <emit>");
  return {
    CNPJ: emit.CNPJ ? str(emit.CNPJ) : null,
    CPF: emit.CPF ? str(emit.CPF) : null,
    xNome: str(emit.xNome),
    xFant: emit.xFant ? str(emit.xFant) : null,
    IE: str(emit.IE),
    IM: emit.IM ? str(emit.IM) : null,
    CNAE: emit.CNAE ? str(emit.CNAE) : null,
    CRT: str(emit.CRT),
    ender: parseEndereco(emit.enderEmit),
  };
}

/**
 * Lê `<dest>`. No modelo 65 (NFC-e) o grupo é OPCIONAL: venda a consumidor não
 * identificado sai sem `<dest>` nenhum — é o que o próprio builder faz
 * (`nfe-xml-builder-sefaz.service.ts`, `buildDest`, ramo `modelo === "65"`), e é
 * o caso mais comum do PDV.
 *
 * Antes isto lançava para qualquer XML sem `<dest>`, o que tornava
 * `DanfeNfcePdfService.generateFromXml` inalcançável justamente na maioria dos
 * cupons. Guard ADITIVO: o modelo 55 continua exigindo o grupo (lá ele é
 * obrigatório e a ausência é XML corrompido), o 65 cai num destinatário neutro
 * que o renderer desenha como "CONSUMIDOR NÃO IDENTIFICADO".
 */
function parseDest(dest: any, modelo?: string): ParsedDest {
  if (!dest) {
    if (modelo === "65") {
      return {
        CNPJ: null,
        CPF: null,
        idEstrangeiro: null,
        xNome: "",
        IE: null,
        indIEDest: "9", // 9 = não contribuinte
        email: null,
        ender: null,
      };
    }
    throw new Error("XML NFe sem <dest>");
  }
  return {
    CNPJ: dest.CNPJ ? str(dest.CNPJ) : null,
    CPF: dest.CPF ? str(dest.CPF) : null,
    idEstrangeiro: dest.idEstrangeiro ? str(dest.idEstrangeiro) : null,
    xNome: str(dest.xNome),
    IE: dest.IE ? str(dest.IE) : null,
    indIEDest: str(dest.indIEDest ?? "9"),
    email: dest.email ? str(dest.email) : null,
    ender: dest.enderDest ? parseEndereco(dest.enderDest) : null,
  };
}

function parseEndereco(ender: any): ParsedEndereco {
  return {
    xLgr: str(ender?.xLgr ?? ""),
    nro: str(ender?.nro ?? ""),
    xCpl: ender?.xCpl ? str(ender.xCpl) : null,
    xBairro: str(ender?.xBairro ?? ""),
    cMun: str(ender?.cMun ?? ""),
    xMun: str(ender?.xMun ?? ""),
    UF: str(ender?.UF ?? ""),
    CEP: str(ender?.CEP ?? ""),
    cPais: str(ender?.cPais ?? "1058"),
    xPais: str(ender?.xPais ?? "BRASIL"),
    fone: ender?.fone ? str(ender.fone) : null,
  };
}

function parseItens(det: any): ParsedItem[] {
  if (!det) return [];
  const items = Array.isArray(det) ? det : [det];
  return items.map((d, i) => {
    const prod = d.prod ?? {};
    return {
      nItem: toInt(d["@_nItem"] ?? String(i + 1)),
      cProd: str(prod.cProd),
      cEAN: str(prod.cEAN ?? "SEM GTIN"),
      xProd: str(prod.xProd),
      NCM: str(prod.NCM),
      CFOP: str(prod.CFOP),
      uCom: str(prod.uCom),
      qCom: toFloat(prod.qCom),
      vUnCom: toFloat(prod.vUnCom),
      vProd: toFloat(prod.vProd),
      vDesc: toFloat(prod.vDesc ?? "0"),
      CEST: prod.CEST ? str(prod.CEST) : null,
      imposto: d.imposto ?? null,
    };
  });
}

function parseTotal(icmsTot: any): ParsedTotal {
  if (!icmsTot) {
    return {
      vBC: 0,
      vICMS: 0,
      vProd: 0,
      vFrete: 0,
      vSeg: 0,
      vDesc: 0,
      vIPI: 0,
      vPIS: 0,
      vCOFINS: 0,
      vOutro: 0,
      vNF: 0,
    };
  }
  return {
    vBC: toFloat(icmsTot.vBC),
    vICMS: toFloat(icmsTot.vICMS),
    vProd: toFloat(icmsTot.vProd),
    vFrete: toFloat(icmsTot.vFrete),
    vSeg: toFloat(icmsTot.vSeg),
    vDesc: toFloat(icmsTot.vDesc),
    vIPI: toFloat(icmsTot.vIPI),
    vPIS: toFloat(icmsTot.vPIS),
    vCOFINS: toFloat(icmsTot.vCOFINS),
    vOutro: toFloat(icmsTot.vOutro),
    vNF: toFloat(icmsTot.vNF),
  };
}

function parseTransp(transp: any): ParsedTransp | null {
  if (!transp) return null;
  const transporta = transp.transporta;
  // <vol> e repetivel; fast-xml-parser devolve objeto quando ha 1 so.
  const volRaw = transp.vol
    ? Array.isArray(transp.vol)
      ? transp.vol
      : [transp.vol]
    : [];
  return {
    modFrete: str(transp.modFrete ?? "9"),
    vol: volRaw.map((v: any) => ({
      qVol: v?.qVol != null ? toFloat(v.qVol) : null,
      esp: v?.esp != null ? str(v.esp) : null,
      marca: v?.marca != null ? str(v.marca) : null,
      nVol: v?.nVol != null ? str(v.nVol) : null,
      pesoL: v?.pesoL != null ? toFloat(v.pesoL) : null,
      pesoB: v?.pesoB != null ? toFloat(v.pesoB) : null,
    })),
    transporta: transporta
      ? {
          CNPJ: transporta.CNPJ ? str(transporta.CNPJ) : null,
          CPF: transporta.CPF ? str(transporta.CPF) : null,
          xNome: transporta.xNome ? str(transporta.xNome) : null,
          IE: transporta.IE ? str(transporta.IE) : null,
          xEnder: transporta.xEnder ? str(transporta.xEnder) : null,
          xMun: transporta.xMun ? str(transporta.xMun) : null,
          UF: transporta.UF ? str(transporta.UF) : null,
        }
      : null,
  };
}

function parsePag(pag: any): ParsedPagamento[] {
  if (!pag) return [];
  const detPag = pag.detPag;
  if (!detPag) return [];
  const items = Array.isArray(detPag) ? detPag : [detPag];
  return items.map((p) => ({
    tPag: str(p.tPag ?? "90"),
    vPag: toFloat(p.vPag),
  }));
}

function parseProtNFe(protNFe: any): ParsedProtNFe | null {
  if (!protNFe) return null;
  const infProt = protNFe.infProt;
  if (!infProt) return null;
  return {
    chNFe: str(infProt.chNFe),
    nProt: str(infProt.nProt),
    dhRecbto: str(infProt.dhRecbto),
    cStat: toInt(infProt.cStat),
    xMotivo: str(infProt.xMotivo),
    digVal: infProt.digVal ? str(infProt.digVal) : null,
  };
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function toInt(v: unknown): number {
  const n = Number(str(v));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toFloat(v: unknown): number {
  const n = Number(str(v));
  return Number.isFinite(n) ? n : 0;
}
