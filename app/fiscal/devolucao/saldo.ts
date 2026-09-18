/**
 * Saldo devolvível por item da nota ORIGINAL (chave + det@nItem).
 *
 * Regras (plano §6.2):
 *   AUTHORIZED                    → devolvidaAutorizada  (consome)
 *   VALIDATING | SIGNING | SENDING → emProcessamento     (reserva — consome)
 *   DRAFT | REJECTED              → emRascunho           (só informa)
 *   CANCELLED | INUTILIZED        → ignorado
 *   status desconhecido           → emProcessamento (conservador: nunca libera saldo)
 *   disponivel = max(0, original − autorizada − emProcessamento)
 *
 * Aritmética em inteiros de 1/10000 (qCom tem 4 casas): 0,1 + 0,2 = 0,3 exato.
 * O valor autoritativo é recalculado pelo repositório sob advisory lock na
 * transação da reserva; este módulo só faz a conta.
 *
 * Módulo PURO — seguro para backend, testes e client.
 */

import { normalizarChaveAcesso } from "../domain/chave-acesso-dv";
import type { SaldoItemOriginal } from "./tipos";

export const ESCALA_QUANTIDADE = 10_000;

const DECIMAL_TEXTO = /^\s*(-?)(\d+)(?:\.(\d*))?\s*$/;

function arredondarMeioParaCima(n: number): number {
  const sinal = n < 0 ? -1 : 1;
  return sinal * Math.floor(Math.abs(n) + 0.5);
}

/**
 * Quantidade → inteiro de 1/10000 (arredondamento meio-para-cima na 5ª casa).
 * Aceita number finito ou texto decimal ("1.0001", vindo de `numeric::text`).
 * `null` para qualquer outra coisa (NaN, "", "1,5", objeto).
 */
export function quantidadeParaUnidades(valor: unknown): number | null {
  let unidades: number;
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) return null;
    // toFixed(6) absorve o erro binário (1.0001 * 1e4 = 10000.999999999998).
    unidades = arredondarMeioParaCima(Number((valor * ESCALA_QUANTIDADE).toFixed(6)));
  } else if (typeof valor === "string") {
    const m = DECIMAL_TEXTO.exec(valor);
    if (!m) return null;
    const frac = (m[3] ?? "").padEnd(5, "0");
    let abs = Number(m[2]) * ESCALA_QUANTIDADE + Number(frac.slice(0, 4));
    if (Number(frac[4]) >= 5) abs += 1;
    unidades = m[1] === "-" ? -abs : abs;
  } else {
    return null;
  }
  return Number.isSafeInteger(unidades) ? unidades : null;
}

export function unidadesParaQuantidade(unidades: number): number {
  return unidades / ESCALA_QUANTIDADE;
}

/** true ⇔ número/texto decimal com no máximo 4 casas (qCom da NF-e). */
export function temAteQuatroCasas(valor: unknown): boolean {
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) return false;
    const escalado = valor * ESCALA_QUANTIDADE;
    return Math.abs(escalado - Math.round(escalado)) < 1e-6;
  }
  if (typeof valor === "string") {
    const m = DECIMAL_TEXTO.exec(valor);
    if (!m) return false;
    return (m[3] ?? "").replace(/0+$/, "").length <= 4;
  }
  return false;
}

export type BaldeSaldo = "AUTORIZADA" | "EM_PROCESSAMENTO" | "RASCUNHO" | "IGNORADA";

export function baldeDoStatus(status: string): BaldeSaldo {
  switch (status) {
    case "AUTHORIZED":
      return "AUTORIZADA";
    case "VALIDATING":
    case "SIGNING":
    case "SENDING":
      return "EM_PROCESSAMENTO";
    case "DRAFT":
    case "REJECTED":
      return "RASCUNHO";
    case "CANCELLED":
    case "INUTILIZED":
      return "IGNORADA";
    default:
      return "EM_PROCESSAMENTO";
  }
}

export interface ItemOriginalParaSaldo {
  nItem: number;
  /** qCom do XML autorizado; null = original sem XML. */
  quantidade: number | string | null;
}

/** Uma linha de NfeDevolucaoItem já juntada com o status da nota de devolução. */
export interface LinhaSaldoDevolucao {
  chave: string;
  nItem: number;
  quantidade: number | string;
  statusDevolucao: string;
  devolucaoNfeId: string;
}

export interface CalcularSaldoInput {
  itensOriginais: ItemOriginalParaSaldo[];
  linhas: LinhaSaldoDevolucao[];
  /** Exclui as linhas desta devolução (validar a própria nota contra o resto). */
  excluirDevolucaoNfeId?: string | null;
  /** Quando informada, considera só linhas desta chave (aceita prefixo "NFe"). */
  chave?: string | null;
}

/** Saldo por nItem, na ordem de `itensOriginais` (nItem repetido: vale o primeiro). */
export function calcularSaldoPorItem(input: CalcularSaldoInput): SaldoItemOriginal[] {
  const chaveFiltro =
    input.chave !== undefined && input.chave !== null
      ? normalizarChaveAcesso(input.chave)
      : undefined;

  const acumulado = new Map<number, { aut: number; proc: number; rasc: number }>();
  for (const l of input.linhas) {
    if (input.excluirDevolucaoNfeId && l.devolucaoNfeId === input.excluirDevolucaoNfeId) continue;
    if (chaveFiltro !== undefined && normalizarChaveAcesso(l.chave) !== chaveFiltro) continue;
    const balde = baldeDoStatus(l.statusDevolucao);
    if (balde === "IGNORADA") continue;
    // Quantidade ilegível numa linha persistida (Decimal) não acontece; se
    // acontecer, não é somada — o recálculo sob lock no repositório é a guarda.
    const u = quantidadeParaUnidades(l.quantidade) ?? 0;
    const acc = acumulado.get(l.nItem) ?? { aut: 0, proc: 0, rasc: 0 };
    if (balde === "AUTORIZADA") acc.aut += u;
    else if (balde === "EM_PROCESSAMENTO") acc.proc += u;
    else acc.rasc += u;
    acumulado.set(l.nItem, acc);
  }

  const vistos = new Set<number>();
  const saida: SaldoItemOriginal[] = [];
  for (const it of input.itensOriginais) {
    if (vistos.has(it.nItem)) continue;
    vistos.add(it.nItem);
    const acc = acumulado.get(it.nItem) ?? { aut: 0, proc: 0, rasc: 0 };
    const original =
      it.quantidade === null || it.quantidade === undefined
        ? null
        : quantidadeParaUnidades(it.quantidade);
    saida.push({
      nItem: it.nItem,
      quantidadeOriginal: original === null ? null : unidadesParaQuantidade(original),
      devolvidaAutorizada: unidadesParaQuantidade(acc.aut),
      emProcessamento: unidadesParaQuantidade(acc.proc),
      emRascunho: unidadesParaQuantidade(acc.rasc),
      disponivel:
        original === null
          ? null
          : unidadesParaQuantidade(Math.max(0, original - acc.aut - acc.proc)),
    });
  }
  return saida;
}

/** Todos os itens com saldo conhecido e zerado (lista vazia ⇒ false). */
export function isTotalmenteDevolvida(saldos: readonly SaldoItemOriginal[]): boolean {
  return saldos.length > 0 && saldos.every((s) => s.disponivel === 0);
}

/** Algum item já teve devolução autorizada ou em processamento. */
export function temDevolucaoConsumindo(saldos: readonly SaldoItemOriginal[]): boolean {
  return saldos.some((s) => s.devolvidaAutorizada > 0 || s.emProcessamento > 0);
}
