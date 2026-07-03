// Formas de pagamento do Financeiro (Contas a Receber / a Pagar).
//
// Fonte ÚNICA de verdade, compartilhada entre backend (usecases) e frontend
// (componentes React). Armazenamos CÓDIGOS estáveis (não rótulos): assim os
// rótulos podem mudar sem migração de dados. Módulo puro (sem imports) →
// seguro de importar tanto no Fastify quanto no bundle do Next.
//
// Decisão de design (Fase 1): `String?` no Prisma + esta constante TS, em vez
// de um enum Prisma — adicionar/remover método no futuro é editar este
// arquivo, sem nova migração. A coluna é nulável: conta sem método é válida.

export const PAYMENT_METHODS = [
  { code: "PIX", label: "PIX" },
  { code: "CREDITO", label: "Cartão de Crédito" },
  { code: "DEBITO", label: "Cartão de Débito" },
  { code: "BOLETO", label: "Boleto" },
  { code: "DINHEIRO", label: "Dinheiro" },
  { code: "TRANSFERENCIA", label: "Transferência / TED" },
  // "Fiado" = venda a prazo (cliente comprou, ainda vai pagar). É uma conta A
  // RECEBER, não uma forma de pagamento efetivada → exclusivo de "a receber"
  // (flag `receivableOnly`). Nunca deve aparecer em Contas a Pagar.
  { code: "FIADO", label: "Fiado (a receber)", receivableOnly: true },
] as const;

export type PaymentMethodCode = (typeof PAYMENT_METHODS)[number]["code"];

export const PAYMENT_METHOD_CODES = PAYMENT_METHODS.map(
  (m) => m.code,
) as readonly string[];

export const PAYMENT_METHOD_LABELS: Record<string, string> = Object.fromEntries(
  PAYMENT_METHODS.map((m) => [m.code, m.label]),
);

// Util de exibição tolerante: código desconhecido/nulo nunca quebra a UI.
export function paymentMethodLabel(code: string | null | undefined): string {
  return code ? (PAYMENT_METHOD_LABELS[code] ?? code) : "—";
}

// Métodos válidos para um contexto (aba do Financeiro). Contas a Pagar NUNCA
// inclui os métodos `receivableOnly` (ex.: "Fiado"). Contas a Receber inclui
// tudo. Kind ausente → trate como o caso mais restrito (payable), para nunca
// vazar "Fiado" onde não deve. `PAYMENT_METHOD_CODES`/`PAYMENT_METHOD_LABELS`
// seguem completos (incluem FIADO), então `paymentMethodLabel("FIADO")` já
// resolve o rótulo em cupom/listagem sem gambiarra.
export function paymentMethodsForKind(kind: "receivable" | "payable") {
  return PAYMENT_METHODS.filter(
    (m) =>
      kind === "receivable" || !("receivableOnly" in m && m.receivableOnly),
  );
}
