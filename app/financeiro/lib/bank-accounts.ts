// BLOCO A — conta bancária / caixa: onde o dinheiro entra e de onde sai.
//
// O sistema nunca teve esse conceito. Havia "quanto entrou" (uma única
// fórmula, `SUM(totalAmount) WHERE status='PAGA'`, repetida em 8 lugares) e
// "por qual forma", mas nunca "para ONDE". A pergunta que isto responde é a do
// fechamento: "esse PIX caiu em qual conta?".
//
// DUAS PONTAS, e ambas importam: entrada (Receivable) e saída (Payable). Sem a
// saída o saldo por conta só cresceria, e um número que só cresce não serve
// para conferir nada.
//
// PRECEDÊNCIA — o detalhe manda sobre o resumo:
//   ReceivablePayment.bankAccountId  (a forma específica: "o PIX foi no Itaú")
//   └─ ausente ⇒ Receivable.bankAccountId  (o destino da venda inteira)
// É a MESMA regra de `COALESCE(ri.scrapId, p.scrapId)` que a sucata já usa, e
// existe por um motivo medido: só 5 das 82 vendas com forma têm linhas de
// pagamento. Destino apenas nas linhas seria inútil para 94% dos casos.
//
// Módulo PURO (sem I/O): serve ao backend e ao bundle.

export interface BankAccountKindDef {
  code: string;
  label: string;
}

/**
 * Tipos de conta. TEXT e não enum do Postgres: tipo novo é editar esta lista,
 * sem DDL — mesma escolha de `paymentMethod` e `saleStage`.
 */
export const BANK_ACCOUNT_KINDS: BankAccountKindDef[] = [
  { code: "BANCO", label: "Conta bancária" },
  { code: "CAIXA", label: "Caixa / dinheiro" },
  { code: "CARTEIRA_DIGITAL", label: "Carteira digital" },
];

// Protótipo NULO: com objeto literal comum, um `kind` valendo "toString"
// devolveria uma FUNÇÃO em vez de cair no fallback, e o React estouraria ao
// renderizá-la. A coluna é TEXT livre.
const KIND_LABELS: Record<string, string> = Object.assign(
  Object.create(null),
  Object.fromEntries(BANK_ACCOUNT_KINDS.map((k) => [k.code, k.label])),
);

export const DEFAULT_BANK_ACCOUNT_KIND = BANK_ACCOUNT_KINDS[0].code;

/** Rótulo do tipo. Código desconhecido volta cru — nunca vira "—". */
export function bankAccountKindLabel(code: string | null | undefined): string {
  if (!code) return bankAccountKindLabel(DEFAULT_BANK_ACCOUNT_KIND);
  return KIND_LABELS[code] ?? code;
}

/**
 * Flag de BACKEND. Ausente ⇒ nenhuma coluna nova é escrita e o `data` dos
 * INSERT/UPDATE fica byte-idêntico ao de hoje.
 */
export function isBankAccountsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.BANK_ACCOUNTS_ENABLED === "1";
}

// Referência literal a process.env.NEXT_PUBLIC_* para o Next inlinar.
const BANK_ACCOUNTS_UI_ENABLED =
  process.env.NEXT_PUBLIC_BANK_ACCOUNTS_ENABLED === "true";

/** Seletor de conta visível nos formulários? Exige `npm run build`. */
export function isBankAccountsUiEnabled(): boolean {
  return BANK_ACCOUNTS_UI_ENABLED;
}

/**
 * Sentinela do seletor para "não informar".
 *
 * Radix Select não aceita `value=""`. Um só lugar para a sentinela evita que a
 * tela mande a palavra literal e ela vire um id de conta inexistente.
 */
export const NO_BANK_ACCOUNT = "__none__";

/** Valor do seletor → o que vai no corpo da requisição. */
export function bankAccountSelectValueToId(value: string): string | null {
  return value === NO_BANK_ACCOUNT || !value ? null : value;
}

/**
 * Fronteira de tipo: o body é `any`, e o valor acaba numa FK.
 *
 * `undefined` (chave ausente) = "não informado, não mexa"; `null` = "limpar".
 * A distinção é o que impede um formulário que não conhece o campo de apagar a
 * conta de um lançamento que já a tinha.
 */
export function normalizeBankAccountId(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): string | null | undefined {
  if (!isBankAccountsEnabled(env)) return undefined;
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const limpo = value.trim();
  if (!limpo) return null;
  // Mesmo alfabeto de um id (cuid e afins), com teto.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(limpo)) return undefined;
  return limpo;
}

export interface BankAccountRef {
  id: string;
  name?: string | null;
  kind?: string | null;
  bankName?: string | null;
  isActive?: boolean | null;
}

/**
 * A conta EFETIVA de uma linha de pagamento.
 *
 * O detalhe manda sobre o resumo — mesma regra do `COALESCE(ri.scrapId,
 * p.scrapId)` da sucata. Função pura porque essa precedência vai ser lida em
 * mais de um lugar, e escrevê-la duas vezes é escrevê-la diferente uma vez.
 */
export function effectiveBankAccountId(
  paymentBankAccountId: string | null | undefined,
  receivableBankAccountId: string | null | undefined,
): string | null {
  return paymentBankAccountId ?? receivableBankAccountId ?? null;
}

/**
 * Como a conta aparece na tela.
 *
 * O banco entra entre parênteses quando existe e não é redundante com o nome:
 * "Itaú da loja" já diz o banco; "Conta principal (Itaú)" não dizia.
 */
export function bankAccountLabel(
  conta: BankAccountRef | null | undefined,
): string {
  if (!conta) return "—";
  const nome = conta.name?.trim();
  if (!nome) return "—";
  const banco = conta.bankName?.trim();
  if (!banco) return nome;
  if (nome.toLowerCase().includes(banco.toLowerCase())) return nome;
  return `${nome} (${banco})`;
}
