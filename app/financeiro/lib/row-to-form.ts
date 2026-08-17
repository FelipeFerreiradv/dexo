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
  /** BLOCO B — vendedor da venda. Ausente em conta a pagar e em API antiga. */
  sellerUserId?: string | null;
  /** BLOCO A — conta de destino/origem. Vale para os dois kinds. */
  bankAccountId?: string | null;
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
    // BLOCO B — vendedor. Omitido quando a linha não o traz (API antiga ou
    // conta a pagar): a mesma regra do resto deste arquivo, e aqui ela vale
    // dobrado — cair em `null` faria o submit APAGAR o vendedor da venda.
    ...(r.sellerUserId !== undefined && { sellerUserId: r.sellerUserId }),
    // BLOCO A — conta de destino/origem. Mesma regra do vendedor: omitido
    // quando a linha não o traz, porque cair em `null` faria o submit APAGAR
    // a conta do lançamento.
    ...(r.bankAccountId !== undefined && { bankAccountId: r.bankAccountId }),
  };
}

/**
 * Fase 1.1 — linhas de pagamento do DETALHE (`GET /:id`) para o formulário.
 *
 * O `GET /:id` sempre devolveu `payments` (o `findById` inclui a relação), mas
 * a edição lia apenas `items` e descartava o resto. Resultado: reabrir uma
 * venda em PIX + Crédito mostrava o bloco de pagamento VAZIO, e o operador
 * concluía que as formas não tinham sido salvas — elas estavam no banco o
 * tempo todo.
 *
 * `tendered` NÃO é reidratado de propósito: é estado de tela para calcular
 * troco, nunca foi persistido, e inventá-lo aqui exibiria um troco falso.
 *
 * Devolve `undefined` (e não `[]`) quando não há linhas: `[]` significa
 * "apague as linhas existentes" no submit, e é exatamente o que NÃO se quer ao
 * abrir uma venda cujo detalhe não pôde ser lido.
 */
export function entryPaymentsToForm(
  payments: unknown,
): Array<{ method: string; amount: number }> | undefined {
  if (!Array.isArray(payments) || payments.length === 0) return undefined;
  return payments
    .filter(
      (p): p is { method: string; amount: number | string } =>
        !!p && typeof p.method === "string" && p.method.length > 0,
    )
    .map((p) => ({ method: p.method, amount: Number(p.amount) }));
}
