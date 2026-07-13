/**
 * NF-e emitidas do IBR (export tabular, nfe_emitidas.csv). Diferente do resumo
 * Vaapt/invoicy, este traz a chave de acesso completa (44 díg) em TODAS as
 * linhas, série e número reais. Mapeia para o mesmo `NfePlanItem` que o
 * executor histórico consome (createHistoric + dedup + avanço de sequência).
 *
 * Códigos do IBR (confirmados nos dados reais):
 *   Status: 0 = autorizada · 1 = cancelada · 2 = autorizada (válida, s/ canc.)
 *   TipoNF: 1 = saída (venda) · 0 = entrada (devolução/compra)
 *
 * Destinatário vem só com o nome (sem CPF/CNPJ) → `customerId` fica nulo no
 * executor, como no v1 do Vaapt.
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { addIssue } from "../import.types";
import { asInt, asNumber, asString, parseFlexibleDate } from "../lib/normalize";
import type { NfePlanItem } from "./vaapt-nfes.mapper";

export interface IbrNfeMapResult {
  items: NfePlanItem[];
  totalRows: number;
  semNumero: number;
  duplicadosColapsados: number;
  porStatus: Record<string, number>;
  semChave: number;
  cnpjsEmitentes: string[];
  avisos: ImportRowIssue[];
}

function mapIbrStatus(raw: string | null): string {
  const s = (raw ?? "").trim();
  // 1 = cancelada; 0 e 2 = nota autorizada/válida (2 não tem sinal de
  // cancelamento nos dados — tratada como autorizada, mais seguro).
  if (s === "1") return "CANCELLED";
  return "AUTHORIZED";
}

export function mapIbrNfes(file: DetectedFile): IbrNfeMapResult {
  const avisos: ImportRowIssue[] = [];
  const porStatus: Record<string, number> = {};
  const cnpjs = new Set<string>();
  let semNumero = 0;
  let semChave = 0;

  // Dedup por (SÉRIE, NÚMERO) — não só por número: um cliente com 2 séries
  // pode ter o número 100 na série 1 E na série 2 (notas distintas). Chavear
  // só por número descartaria a 2ª silenciosamente.
  const bySerieNum = new Map<string, NfePlanItem>();

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (label: string) => file.get(row, label);
    const linha = i + 1;

    const numero = asInt(get("NumeroNotaFiscal"));
    if (numero === null) {
      semNumero++;
      continue;
    }

    const chaveRaw = asString(get("ChaveDeAcesso"));
    const chave = chaveRaw && /^\d{44}$/.test(chaveRaw) ? chaveRaw : null;
    if (!chave) {
      semChave++;
      addIssue(avisos, {
        linha,
        motivo: `NF-e ${numero}: chave de acesso inválida — importada sem chave`,
      });
    }
    // Série: campo próprio; confere com a chave (posições 22-25) quando há.
    const serieCampo = asInt(get("Serie"));
    const serie = chave ? parseInt(chave.slice(22, 25), 10) : (serieCampo ?? 1);
    const dedupKey = `${serie}/${numero}`;
    if (bySerieNum.has(dedupKey)) continue;

    const cnpjEmitente = chave ? chave.slice(6, 20) : null;
    if (cnpjEmitente) cnpjs.add(cnpjEmitente);

    const status = mapIbrStatus(asString(get("Status")));
    porStatus[status] = (porStatus[status] ?? 0) + 1;

    // TipoNF: 1 = saída, 0 = entrada.
    const tipoNF = (asString(get("TipoNF")) ?? "1").trim();
    const tipo = tipoNF === "0" ? "ENTRADA" : "SAIDA";
    const naturezaCampo = asString(get("NaturezaOperacao"));
    const valor = asNumber(get("ValorTotal")) ?? 0;
    const dataEmissao = parseFlexibleDate(get("DataEmissao"));

    const infoParts = ["Import Dexo · NF-e histórica (IBR)"];
    if (naturezaCampo) infoParts.push(naturezaCampo);
    const situacao = asString(get("Status"));
    if (situacao) infoParts.push(`status IBR ${situacao}`);

    bySerieNum.set(dedupKey, {
      linha,
      numero,
      serie,
      chaveAcesso: chave,
      status,
      tipoOperacao: tipo,
      destinoOperacao: "INTERNA",
      naturezaOperacao:
        naturezaCampo ?? (tipo === "SAIDA" ? "VENDA" : "ENTRADA"),
      valor,
      dataEmissao,
      // Autorizada/Cancelada têm data de autorização = emissão (o dump não
      // traz uma coluna separada); Negada/Inutilizada não se aplicam aqui.
      dataAutorizacao:
        status === "AUTHORIZED" || status === "CANCELLED" ? dataEmissao : null,
      nomeDestinatario: asString(get("NomeDestinatario")) ?? "",
      cnpjEmitente,
      informacoesComplementares: infoParts.join(" · "),
    });
  }

  const items = Array.from(bySerieNum.values()).sort(
    (a, b) => a.serie - b.serie || a.numero - b.numero,
  );
  return {
    items,
    totalRows: file.rows.length,
    semNumero,
    duplicadosColapsados: file.rows.length - bySerieNum.size - semNumero,
    porStatus,
    semChave,
    cnpjsEmitentes: [...cnpjs],
    avisos,
  };
}
