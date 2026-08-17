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

// ── Bloco A: mais de uma forma de pagamento na mesma venda ───────────────────

export interface PaymentLine {
  method: string;
  amount: number;
}

/**
 * Converte reais para CENTAVOS inteiros.
 *
 * Todo fechamento de caixa é comparado em centavos, nunca em float: em ponto
 * flutuante `0.1 + 0.2 !== 0.3`, e uma venda de R$ 1.000,00 paga com três
 * formas fecharia "por um centavo" sem que nada esteja errado.
 */
export function toCents(value: number): number {
  return Math.round(Number(value) * 100);
}

/** Soma das linhas, em centavos. */
export function sumPaymentsCents(payments: PaymentLine[]): number {
  return payments.reduce((acc, p) => acc + toCents(p.amount), 0);
}

/**
 * Método PREDOMINANTE de uma venda: o de MAIOR valor somado.
 *
 * É o que vai para `Receivable.paymentMethod`, mantendo intactos os 41 pontos
 * que leem aquele campo escalar (coluna "Forma", filtro da listagem, KPIs do
 * PDV, dashboards, relatório em PDF, mapeamento fiscal).
 *
 * Empate → vence quem aparece primeiro em PAYMENT_METHODS. A ordem é fixa e
 * declarada, então o resultado é determinístico: a mesma venda nunca é
 * classificada de dois jeitos diferentes.
 *
 * Lista vazia → null (a conta simplesmente não tem método, como hoje).
 */
export function predominantPaymentMethod(
  payments: PaymentLine[] | null | undefined,
): string | null {
  if (!payments || payments.length === 0) return null;

  const totals = new Map<string, number>();
  for (const p of payments) {
    totals.set(p.method, (totals.get(p.method) ?? 0) + toCents(p.amount));
  }

  const order = (code: string) => {
    const i = PAYMENT_METHOD_CODES.indexOf(code);
    // Código desconhecido vai para o fim do desempate, nunca para o começo.
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };

  let winner: string | null = null;
  let winnerCents = -1;
  for (const [method, cents] of totals) {
    if (
      cents > winnerCents ||
      (cents === winnerCents && winner !== null && order(method) < order(winner))
    ) {
      winner = method;
      winnerCents = cents;
    }
  }
  return winner;
}

/**
 * Fase 1.1 — rótulo da coluna "Forma" quando a venda tem N formas.
 *
 * A coluna sempre mostrou o método PREDOMINANTE (o escalar
 * `Receivable.paymentMethod`), o que fazia uma venda em PIX + Crédito parecer
 * uma venda só em Crédito — e o operador concluía que a segunda forma não
 * tinha sido salva.
 *
 * Compatibilidade: com 0 ou 1 linha o retorno é EXATAMENTE
 * `paymentMethodLabel(predominante)`, então a venda de uma forma só continua
 * renderizando byte-idêntica. O sufixo só aparece a partir da segunda linha.
 *
 * Devolve o texto pronto e, à parte, o detalhe por extenso para `title`/tooltip
 * — quem chama decide se usa.
 */
export function paymentMethodsSummary(
  predominant: string | null | undefined,
  payments?: { method: string; amount: number }[] | null,
): { label: string; detail: string | null } {
  const linhas = Array.isArray(payments) ? payments : [];
  const base = paymentMethodLabel(predominant);
  if (linhas.length <= 1) return { label: base, detail: null };

  // O predominante primeiro (é o que a coluna sempre mostrou); o resto vira
  // contagem, para a coluna não quebrar o layout com 4 formas.
  const outras = linhas.length - 1;
  const detail = linhas
    .map(
      (p) =>
        `${paymentMethodLabel(p.method)}: ${p.amount.toLocaleString("pt-BR", {
          style: "currency",
          currency: "BRL",
        })}`,
    )
    .join(" · ");
  return { label: `${base} +${outras}`, detail };
}
