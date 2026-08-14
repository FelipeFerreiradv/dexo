// BLOCO D — motivo do cancelamento da venda.
//
// O cliente pediu motivo OBRIGATÓRIO; a decisão de produto foi deixá-lo
// OPCIONAL. Isso muda a garantia que o sistema precisa dar: não dá para
// bloquear o cancelamento por falta de motivo, mas o motivo que o operador se
// deu ao trabalho de informar não pode se perder. Por isso ele é gravado em
// COLUNA, dentro da MESMA transação que grava CANCELADA — e não só no log de
// auditoria, que é best-effort e pode falhar sem que ninguém veja.
//
// Módulo PURO (sem imports, sem I/O): serve ao backend (normalização do body)
// e ao bundle do Next (lista do diálogo), exatamente como `payment-methods.ts`.
//
// CÓDIGOS estáveis, não rótulos: o rótulo pode mudar sem migração de dados, e
// o relatório "quantos cancelamentos por causa" agrupa por código.

export const CANCEL_REASONS = [
  { code: "CLIENTE_DESISTIU", label: "Desistência do cliente" },
  { code: "ERRO_LANCAMENTO", label: "Erro de lançamento" },
  { code: "PECA_DEFEITO", label: "Peça com defeito" },
  { code: "TROCA", label: "Troca por outra peça" },
  { code: "OUTRO", label: "Outro motivo" },
] as const;

export type CancelReasonCode = (typeof CANCEL_REASONS)[number]["code"];

// Protótipo NULO de propósito. Com um objeto literal comum, `"toString" in
// LABELS` é `true` e `LABELS["toString"]` devolve uma FUNÇÃO — o que faria um
// body `{cancelReasonCode:"toString"}` passar na validação e a tela tentar
// renderizar uma função como rótulo. Com `Object.create(null)` a classe
// inteira de bug deixa de existir.
const CANCEL_REASON_LABELS: Record<string, string> = Object.assign(
  Object.create(null),
  Object.fromEntries(CANCEL_REASONS.map((r) => [r.code, r.label])),
);

/** Exibição tolerante: código desconhecido volta cru, nunca some da tela. */
export function cancelReasonLabel(
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  return CANCEL_REASON_LABELS[code] ?? code;
}

/**
 * Texto pronto para o operador, juntando código e observação.
 * `null` quando não há nem um nem outro — e aí a tela não mostra nada.
 */
export function describeCancelReason(
  code: string | null | undefined,
  note: string | null | undefined,
): string | null {
  const rotulo = cancelReasonLabel(code);
  const obs = note && note.trim() ? note.trim() : null;
  if (rotulo && obs) return `${rotulo} — ${obs}`;
  return rotulo ?? obs;
}

/**
 * Limite da observação livre.
 *
 * A tela já limita o textarea, então isto é a defesa de FRONTEIRA: um `curl`
 * pode mandar 1 MB, e essa string entra numa transação que devolve estoque.
 */
export const CANCEL_NOTE_MAX = 500;

export interface NormalizedCancelReason {
  code: string | null;
  note: string | null;
}

/**
 * Flag de BACKEND. Ausente ⇒ `normalizeCancelReason` devolve tudo nulo, o
 * `data` do UPDATE fica byte-idêntico ao de hoje e NADA toca as colunas novas.
 *
 * É o que torna seguro subir o código ANTES do DDL: a gravação acontece DENTRO
 * da transação do estorno, então escrever numa coluna inexistente não seria um
 * log perdido — derrubaria o cancelamento inteiro.
 */
export function isCancelReasonEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SALE_CANCEL_REASON_ENABLED === "1";
}

// Flag de UI. Referência LITERAL a process.env.NEXT_PUBLIC_* para o Next
// inlinar no bundle (convenção de pdv-actions.ts:15-19).
//
// São DUAS flags porque vivem em processos diferentes — esta exige `npm run
// build`, a de backend liga com `pm2 restart`. Ligar só esta faz o operador
// digitar um motivo que o backend descarta; ligar só a de backend deixa o
// campo invisível e o comportamento igual ao de hoje. A ordem certa está no
// cabeçalho de prisma/ddl/2026-08-14-receivable-cancel-reason.sql.
const CANCEL_REASON_UI_ENABLED =
  process.env.NEXT_PUBLIC_SALE_CANCEL_REASON_ENABLED === "true";

/** Campo de motivo visível no diálogo de cancelamento? */
export function isCancelReasonUiEnabled(): boolean {
  return CANCEL_REASON_UI_ENABLED;
}

/**
 * Fronteira de tipo do `POST /reverse`: o body é `any` e pode não existir.
 *
 * Regras, todas permissivas de propósito (o motivo é opcional — nada aqui pode
 * IMPEDIR um cancelamento):
 *  - código fora do vocabulário vira `null`. Nunca gravamos lixo numa coluna
 *    de onde vai sair relatório.
 *  - observação sem código é válida (o operador só escreveu).
 *  - código sem observação é válido (o caso comum, um clique).
 *  - string vazia/em branco é ausência, não valor.
 */
export function normalizeCancelReason(
  body: unknown,
  env: Record<string, string | undefined> = process.env,
): NormalizedCancelReason {
  if (!isCancelReasonEnabled(env)) return { code: null, note: null };
  if (!body || typeof body !== "object") return { code: null, note: null };

  const b = body as Record<string, unknown>;

  const bruto = b.cancelReasonCode;
  const code =
    typeof bruto === "string" && bruto in CANCEL_REASON_LABELS ? bruto : null;

  const nota = b.cancelReason;
  const limpo = typeof nota === "string" ? nota.trim() : "";
  // Truncar (e não rejeitar) porque rejeitar significaria abortar o
  // cancelamento por causa da observação — o inverso da prioridade certa.
  const note = limpo ? limpo.slice(0, CANCEL_NOTE_MAX) : null;

  return { code, note };
}
