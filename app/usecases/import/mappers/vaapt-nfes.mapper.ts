/**
 * NF-e históricas do Vaapt — resumo "invoicy" (aba "Java Books", rótulos
 * deslocados). A base tem números REPETIDOS por re-emissão (Negada/
 * Inutilizado → nova tentativa): colapsa para 1 registro por número com a
 * prioridade Autorizada > Cancelada > Inutilizado > Negada (depois "tem
 * chave", depois emissão mais recente) — paridade exata com
 * scripts/migracao-vaapt-nfes.ts. Sem itens/impostos (a origem é resumo);
 * sem CPF/CNPJ do destinatário (decisão: customerId fica nulo no v1 —
 * casar por nome seria chute).
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { asInt, asNumber, asString, parseFlexibleDate } from "../lib/normalize";

export interface NfePlanItem {
  linha: number;
  numero: number;
  serie: number;
  chaveAcesso: string | null;
  /** AUTHORIZED | CANCELLED | INUTILIZED | REJECTED. */
  status: string;
  tipoOperacao: string;
  destinoOperacao: string;
  naturezaOperacao: string;
  valor: number;
  dataEmissao: Date | null;
  dataAutorizacao: Date | null;
  nomeDestinatario: string;
  cnpjEmitente: string | null;
  informacoesComplementares: string;
}

export interface NfeMapResult {
  items: NfePlanItem[];
  totalRows: number;
  semNumero: number;
  duplicadosColapsados: number;
  porStatus: Record<string, number>;
  semChave: number;
  cnpjsEmitentes: string[];
  avisos: ImportRowIssue[];
}

/** Status invoicy → status Dexo (mesma tabela do script). */
export function mapNfeStatus(situacao: string | null): string {
  const s = (situacao ?? "").toLowerCase();
  // "Cancelamento negado" = cancelamento RECUSADO → a nota segue válida.
  if (s.includes("cancel") && s.includes("nega")) return "AUTHORIZED";
  if (s.includes("autoriz")) return "AUTHORIZED";
  if (s.includes("cancel")) return "CANCELLED";
  if (s.includes("inutiliz")) return "INUTILIZED";
  if (s.includes("nega")) return "REJECTED";
  return "AUTHORIZED";
}

const STATUS_PRIORITY: Record<string, number> = {
  Autorizada: 1,
  Cancelada: 2,
  Inutilizado: 3,
  Negada: 4,
};

/** CFOP → tipoOperacao / destinoOperacao (1º dígito). */
export function cfopDerive(cfop: string | null): {
  tipo: string;
  destino: string;
} {
  const d1 = (cfop ?? "").trim()[0];
  const tipo = d1 === "1" || d1 === "2" || d1 === "3" ? "ENTRADA" : "SAIDA";
  const destino =
    d1 === "1" || d1 === "5"
      ? "INTERNA"
      : d1 === "2" || d1 === "6"
        ? "INTERESTADUAL"
        : d1 === "3" || d1 === "7"
          ? "EXTERIOR"
          : "INTERNA";
  return { tipo, destino };
}

export function mapVaaptNfes(file: DetectedFile): NfeMapResult {
  const avisos: ImportRowIssue[] = [];
  const porStatus: Record<string, number> = {};
  const cnpjs = new Set<string>();
  let semNumero = 0;
  let semChave = 0;

  // Agrupa por número — 1 registro por número, com prioridade de status.
  const byNum = new Map<number, Array<{ row: DetectedFile["rows"][0]; linha: number }>>();
  for (let i = 0; i < file.rows.length; i++) {
    const numero = asInt(file.get(file.rows[i], "N° NFe"));
    if (numero === null) {
      semNumero++;
      continue;
    }
    const arr = byNum.get(numero) ?? [];
    arr.push({ row: file.rows[i], linha: i + 1 });
    byNum.set(numero, arr);
  }

  const items: NfePlanItem[] = [];
  for (const [numero, rowsN] of byNum) {
    const sorted = [...rowsN].sort((a, b) => {
      const pa =
        STATUS_PRIORITY[
          String(file.get(a.row, "Status da NFe") ?? "").trim()
        ] ?? 9;
      const pb =
        STATUS_PRIORITY[
          String(file.get(b.row, "Status da NFe") ?? "").trim()
        ] ?? 9;
      if (pa !== pb) return pa - pb;
      const ca = asString(file.get(a.row, "Chave de Acesso")) ? 0 : 1;
      const cb = asString(file.get(b.row, "Chave de Acesso")) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const da =
        parseFlexibleDate(file.get(a.row, "Data de Emissão"))?.getTime() ?? 0;
      const db =
        parseFlexibleDate(file.get(b.row, "Data de Emissão"))?.getTime() ?? 0;
      return db - da;
    });
    const { row, linha } = sorted[0];
    const get = (label: string) => file.get(row, label);

    const situacao = asString(get("Status da NFe"));
    const status = mapNfeStatus(situacao);
    porStatus[status] = (porStatus[status] ?? 0) + 1;

    const chaveRaw = asString(get("Chave de Acesso"));
    const chave = chaveRaw && /^\d{44}$/.test(chaveRaw) ? chaveRaw : null;
    if (!chave) semChave++;
    if (chaveRaw && !chave) {
      avisos.push({
        linha,
        motivo: `NF-e ${numero}: chave de acesso "${chaveRaw}" inválida — importada sem chave`,
      });
    }
    // Série e CNPJ do emitente vêm da CHAVE (posições 22-25 e 6-20); o
    // NÚMERO vem da coluna (a chave pode faltar em notas negadas).
    const serie = chave ? parseInt(chave.slice(22, 25), 10) : 1;
    const cnpjEmitente = chave ? chave.slice(6, 20) : null;
    if (cnpjEmitente) cnpjs.add(cnpjEmitente);

    const cfop = asString(get("CFOP"));
    const { tipo, destino } = cfopDerive(cfop);
    const valor = asNumber(get("Valor Total da NFe")) ?? 0;
    const dataEmissao = parseFlexibleDate(get("Data de Emissão"));
    const dataAutorizacao = parseFlexibleDate(get("Data de Autorização"));
    const motivo = asString(get("Motivo do cancelamento"));

    const infoParts = ["Import Dexo · NF-e histórica (invoicy)"];
    if (cfop) infoParts.push(`CFOP ${cfop}`);
    if (situacao) infoParts.push(situacao);
    if (motivo) infoParts.push(`motivo: ${motivo}`);

    items.push({
      linha,
      numero,
      serie,
      chaveAcesso: chave,
      status,
      tipoOperacao: tipo,
      destinoOperacao: destino,
      naturezaOperacao: tipo === "SAIDA" ? "VENDA" : "ENTRADA",
      valor,
      dataEmissao,
      // Autorizada/Cancelada têm autorização; fallback = emissão (paridade
      // com o script). Negada/Inutilizada ficam sem.
      dataAutorizacao:
        status === "AUTHORIZED" || status === "CANCELLED"
          ? (dataAutorizacao ?? dataEmissao)
          : null,
      nomeDestinatario: asString(get("Nome do Cliente")) ?? "",
      cnpjEmitente,
      informacoesComplementares: infoParts.join(" · "),
    });
  }

  items.sort((a, b) => a.numero - b.numero);
  const dataRows = file.rows.length;
  return {
    items,
    totalRows: dataRows,
    semNumero,
    duplicadosColapsados: dataRows - byNum.size - semNumero,
    porStatus,
    semChave,
    cnpjsEmitentes: [...cnpjs],
    avisos,
  };
}
