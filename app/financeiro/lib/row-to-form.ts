// Fase 1.0 — hidratação do formulário de edição a partir da LINHA da listagem.
//
// POR QUE ISTO É UM MÓDULO PURO (mesma disciplina de `pdv-actions.ts`):
// o bug que ele corrige é invisível na tela e só aparece DEPOIS de salvar, o
// que o torna caro de pegar em smoke manual. Como tabela pura, vira teste.
//
// O BUG: o dialog hidrata com `reset({ ...DEFAULT_FINANCE_VALUES, ...initialData })`
// e o submit envia o FORMULÁRIO INTEIRO no PUT. Todo campo editável que não
// entra aqui volta ao default do form e é regravado por cima do que estava no
// banco — editar uma conta zerava multa, juros, tolerância e detalhes da
// dívida, e fixava `periodDays` em 30.
//
// A regra, portanto: **todo campo editável pelo formulário tem de constar
// aqui**. Um campo novo no wizard sem uma linha correspondente neste arquivo
// reintroduz a perda de dados.

import type { FinanceEntryFormData } from "./finance-schema";

/** Recorte da linha da listagem que alimenta o formulário. */
export interface FinanceRowForForm {
  id: string;
  document: string | null;
  reason: string | null;
  paymentMethod?: string | null;
  totalAmount: number;
  installments: number;
  dueDate: string;
  unidadeId?: string | null;
  customer?: { id: string; name: string; cpf: string | null } | null;
  debtDetails?: string | null;
  fineAmount?: number | null;
  finePercent?: number | null;
  interestPercent?: number | null;
  toleranceDays?: number | null;
  periodDays?: number | null;
}

export type FinanceFormSeed = Partial<FinanceEntryFormData> & {
  id?: string;
  customer?: FinanceRowForForm["customer"];
  items?: unknown[];
};

/**
 * Converte a linha da listagem no objeto `initialData` do FinanceDialog.
 *
 * Campos ausentes na linha (`undefined`) são OMITIDOS em vez de virarem
 * `null`: se a API ainda não devolver o campo — front implantado antes do
 * restart da API —, o certo é o formulário cair no default de hoje, e não
 * gravar `null` por cima de um valor que existe no banco.
 */
export function financeRowToFormSeed(r: FinanceRowForForm): FinanceFormSeed {
  return {
    id: r.id,
    customerId: r.customer?.id || "",
    customer: r.customer,
    unidadeId: r.unidadeId ?? null,
    document: r.document,
    reason: r.reason,
    paymentMethod: r.paymentMethod ?? null,
    totalAmount: r.totalAmount,
    installments: r.installments,
    dueDate: r.dueDate?.slice(0, 10),
    ...(r.debtDetails !== undefined && { debtDetails: r.debtDetails }),
    ...(r.fineAmount !== undefined && { fineAmount: r.fineAmount }),
    ...(r.finePercent !== undefined && { finePercent: r.finePercent }),
    ...(r.interestPercent !== undefined && {
      interestPercent: r.interestPercent,
    }),
    ...(r.toleranceDays !== undefined && { toleranceDays: r.toleranceDays }),
    ...(r.periodDays !== undefined && { periodDays: r.periodDays }),
  };
}
