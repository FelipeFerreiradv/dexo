// Bloco B — cálculo do plano de entrada + parcelas.
//
// Módulo PURO (sem React, sem fetch): é a MESMA função que desenha a prévia na
// tela e que monta o payload enviado ao backend. Uma fonte só evita o clássico
// "a tela mostra 3x de 33,34 e o banco grava 33,33".
//
// Duas armadilhas resolvidas aqui:
//  1. CENTAVOS — tudo em inteiro. Em float, 1000/3 gera 333.33333... e a soma
//     das parcelas não fecha com o total.
//  2. RESÍDUO — a divisão quase nunca é exata. A ÚLTIMA parcela absorve a
//     sobra, então a soma bate ao centavo e nunca aparece uma parcela de
//     R$ 0,01 solta no meio.

export interface InstallmentPlanLine {
  /** ISO-8601. O backend faz `new Date(...)`. */
  dueDate: string;
  amount: number;
}

export interface BuiltInstallmentPlan {
  downPayment: number;
  installments: InstallmentPlanLine[];
  /** Saldo parcelado (total − entrada), por conveniência da UI. */
  balance: number;
}

export interface BuildInstallmentPlanInput {
  totalAmount: number;
  downPayment: number;
  /** Número de parcelas do SALDO. */
  count: number;
  /** Intervalo entre vencimentos, em dias. */
  periodDays: number;
  /** Vencimento da 1ª parcela (yyyy-mm-dd ou ISO). */
  firstDueDate: string;
}

const cents = (v: number) => Math.round(Number(v || 0) * 100);

/**
 * Soma dias a uma data em UTC.
 *
 * UTC de propósito: `yyyy-mm-dd` é interpretado como meia-noite UTC pelo
 * `new Date`, e somar dias no fuso local faria a data "andar" um dia para
 * quem está em UTC-3 — um vencimento marcado para o dia 10 viraria dia 9.
 */
function addDaysUTC(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Monta o plano. Devolve `null` quando os dados ainda não fecham um plano
 * válido (a UI usa isso para não desenhar prévia de lixo enquanto o operador
 * digita) — a validação com MENSAGEM fica no zod e no backend.
 */
export function buildInstallmentPlan(
  input: BuildInstallmentPlanInput,
): BuiltInstallmentPlan | null {
  const totalC = cents(input.totalAmount);
  const entradaC = cents(input.downPayment);
  const n = Math.trunc(Number(input.count) || 0);

  if (totalC <= 0 || entradaC <= 0 || n < 1) return null;
  const saldoC = totalC - entradaC;
  // Entrada >= total não é parcelamento: é venda à vista.
  if (saldoC <= 0) return null;
  // Nem faz sentido parcelar em mais partes do que há centavos.
  if (n > saldoC) return null;

  const base = new Date(input.firstDueDate);
  if (Number.isNaN(base.getTime())) return null;

  const periodo = Math.max(0, Math.trunc(Number(input.periodDays) || 0));
  const porParcelaC = Math.floor(saldoC / n);

  const installments: InstallmentPlanLine[] = [];
  let acumulado = 0;
  for (let i = 0; i < n; i++) {
    const ultima = i === n - 1;
    // A última absorve o resíduo — assim Σ parcelas === saldo, sempre.
    const valorC = ultima ? saldoC - acumulado : porParcelaC;
    acumulado += valorC;
    installments.push({
      dueDate: addDaysUTC(base, i * periodo).toISOString(),
      amount: valorC / 100,
    });
  }

  return {
    downPayment: entradaC / 100,
    installments,
    balance: saldoC / 100,
  };
}
