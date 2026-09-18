/**
 * Modo de referência da NF-e de devolução ao documento original (plano §6.1):
 *
 *   HOMOLOGACAO                         → ITEM  (a regra já vale em homologação)
 *   PRODUCAO, data BR <  desde (05/10)  → NOTA  (ide/NFref/refNFe)
 *   PRODUCAO, data BR >= desde          → ITEM  (det/DFeReferenciado em todo item)
 *
 * Nunca os dois (rejeição 1010). A data é a do Brasil (UTC-03:00 fixo, sem
 * horário de verão desde 2019 — mesma convenção de `brazilParts` do montador
 * SEFAZ), independente do fuso do servidor.
 *
 * `desdeISO` vem de NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE (lido por quem chama —
 * este módulo não lê env). Valor ausente/inválido ⇒ padrão 2026-10-05.
 *
 * Módulo PURO — seguro para backend, testes e client.
 */

import type { ModoReferenciaDevolucao } from "./tipos";

export const DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO = "2026-10-05";

const OFFSET_BRASIL_MIN = -180;
const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD do instante no horário de Brasília; null para Date inválida. */
export function dataBrasilISO(instante: Date): string | null {
  if (!(instante instanceof Date) || Number.isNaN(instante.getTime())) return null;
  const d = new Date(instante.getTime() + OFFSET_BRASIL_MIN * 60_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Data de corte válida (calendário real) ou o padrão. */
export function normalizarDesdeISO(desde: string | null | undefined): string {
  if (typeof desde !== "string") return DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO;
  const s = desde.trim();
  const m = DATA_ISO.exec(s);
  if (!m) return DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(ano, mes - 1, dia));
  const real =
    t.getUTCFullYear() === ano && t.getUTCMonth() === mes - 1 && t.getUTCDate() === dia;
  return real ? s : DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO;
}

export function modoReferenciaDevolucao(
  ambiente: string,
  agora: Date,
  desdeISO?: string | null,
): ModoReferenciaDevolucao {
  if (ambiente === "HOMOLOGACAO") return "ITEM";
  // Qualquer outro valor é tratado como PRODUÇÃO (regra de data).
  const hoje = dataBrasilISO(agora);
  if (hoje === null) return "NOTA";
  return hoje >= normalizarDesdeISO(desdeISO) ? "ITEM" : "NOTA";
}
