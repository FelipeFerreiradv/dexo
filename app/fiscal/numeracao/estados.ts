/**
 * Numeração V2 — máquina de estados da reserva (NfeNumeroReserva.estado).
 *
 * Toda escrita de estado no serviço carrega `WHERE "estado" = $de`; esta tabela
 * é a fonte de verdade de QUAIS pares (de → para) são permitidos. Ver
 * docs/fiscal-numeracao-v2.md e design §4.3.
 *
 * Proibidas de propósito (e cobertas por teste):
 *  - INCERTO/EM_TRANSMISSAO → ABANDONADO: número que pode estar autorizado na
 *    SEFAZ nunca é descartado; primeiro se consulta.
 *  - INCERTO → REJEITADO: rejeição é resposta a uma tentativa NOVA, que precisa
 *    passar por EM_TRANSMISSAO.
 *
 * Módulo PURO.
 */

import type { EstadoReserva } from "./tipos";

export type { EstadoReserva } from "./tipos";
export { ESTADOS_REUSAVEIS, ESTADOS_VIVOS, ESTADOS_CONSUMIDOS } from "./tipos";

/** Todos os estados, na ordem do CHECK do DDL. */
export const ESTADOS_RESERVA: readonly EstadoReserva[] = [
  "RESERVADO",
  "REJEITADO",
  "EM_TRANSMISSAO",
  "INCERTO",
  "BLOQUEADO",
  "AUTORIZADO",
  "CANCELADO",
  "DENEGADO",
  "INUTILIZADO",
  "CONSUMIDO_EXTERNO",
  "ABANDONADO",
];

/**
 * Transições permitidas.
 *
 * Além da tabela do §4.3, duas transições que o próprio design exige em outros
 * pontos (sem elas o serviço lançaria no caminho feliz):
 *  - RESERVADO/REJEITADO → CONSUMIDO_EXTERNO: read-back da Focus encontrou o
 *    número usado por OUTRO documento (§4.7 passo 2, NUMERO_USADO_VIA_FOCUS).
 *  - ABANDONADO → INUTILIZADO: inutilização aceita sobre número abandonado
 *    (§4.15 passo 5).
 *
 * AUTORIZADO → ABANDONADO só no realinhamento da Focus (nº divergente), antes
 * do `handleAuthorized`. BLOQUEADO não sai por rotina: só conferência manual.
 */
export const TRANSICOES: Readonly<Record<EstadoReserva, readonly EstadoReserva[]>> = {
  RESERVADO: ["EM_TRANSMISSAO", "ABANDONADO", "INUTILIZADO", "CONSUMIDO_EXTERNO"],
  REJEITADO: ["EM_TRANSMISSAO", "ABANDONADO", "INUTILIZADO", "CONSUMIDO_EXTERNO"],
  EM_TRANSMISSAO: [
    "AUTORIZADO",
    "REJEITADO",
    "RESERVADO",
    "INCERTO",
    "DENEGADO",
    "INUTILIZADO",
    "CONSUMIDO_EXTERNO",
    "BLOQUEADO",
  ],
  INCERTO: [
    "AUTORIZADO",
    "RESERVADO",
    "DENEGADO",
    "INUTILIZADO",
    "CONSUMIDO_EXTERNO",
    "BLOQUEADO",
    "INCERTO",
  ],
  AUTORIZADO: ["CANCELADO", "ABANDONADO"],
  BLOQUEADO: [],
  CANCELADO: [],
  DENEGADO: [],
  INUTILIZADO: [],
  CONSUMIDO_EXTERNO: [],
  ABANDONADO: ["INUTILIZADO"],
};

export function isEstadoReserva(valor: unknown): valor is EstadoReserva {
  return (
    typeof valor === "string" &&
    (ESTADOS_RESERVA as readonly string[]).includes(valor)
  );
}

export function podeTransicionar(de: unknown, para: unknown): boolean {
  if (!isEstadoReserva(de) || !isEstadoReserva(para)) return false;
  return TRANSICOES[de].includes(para);
}

export class TransicaoInvalidaError extends Error {
  readonly code = "NUMERACAO_TRANSICAO_INVALIDA";
  constructor(
    readonly de: string,
    readonly para: string,
  ) {
    super(`Transição de numeração não permitida: ${de} → ${para}`);
    this.name = "TransicaoInvalidaError";
  }
}

/** Lança `TransicaoInvalidaError` quando o par não é permitido. */
export function assertTransicao(de: unknown, para: unknown): void {
  if (!podeTransicionar(de, para)) {
    throw new TransicaoInvalidaError(String(de), String(para));
  }
}
