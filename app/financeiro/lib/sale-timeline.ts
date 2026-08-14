// BLOCO H — histórico da venda.
//
// Tabela dedicada, e não `SystemLog`, por uma razão concreta: existe rota que
// apaga logs antigos (90 dias por padrão), então o histórico da venda sumiria
// sozinho. Aqui ele dura o que a venda durar.
//
// DISCIPLINA (herdada de `logFinanceAction`, e é ela que torna isto seguro):
// toda escrita é BEST-EFFORT e PÓS-COMMIT. Uma falha de auditoria jamais pode
// desfazer uma venda, um recebimento ou um estorno. Em troca, um evento pode
// se perder numa falha rara de banco — trade aceito conscientemente.
//
// ⚠️ Se o motivo do cancelamento virar OBRIGATÓRIO (o cliente pediu isso; a
// decisão atual é opcional), esta escolha precisa ser revisitada: um motivo
// obrigatório que pode se perder não é obrigatório de verdade.

import prisma from "@/app/lib/prisma";

/**
 * Tipos de evento. String e não enum de propósito — tipo novo não pode exigir
 * `ALTER TYPE` no Postgres.
 */
export const SALE_EVENT_TYPES = [
  "CREATED",
  "UPDATED",
  "PAID",
  "REVERSED",
  "FISCAL_EMITTED",
] as const;

export type SaleEventType = (typeof SALE_EVENT_TYPES)[number];

export interface SaleEventActor {
  id?: string | null;
  name?: string | null;
}

export interface RecordSaleEventInput {
  receivableId: string;
  /** Dono dos dados (admin do tenant) — escopo de toda leitura. */
  userId: string;
  type: SaleEventType;
  /** Texto pronto para o operador. A tela não monta frase a partir do tipo. */
  message: string;
  /**
   * Payload MÍNIMO. LGPD: valores, contagens e ids — nunca CPF, endereço ou
   * dados do cliente. O que entra aqui é lido por quem abre a venda.
   */
  details?: Record<string, unknown>;
  actor?: SaleEventActor;
}

/**
 * A gravação só acontece com a flag ligada. Isso existe para a ORDEM DE
 * IMPLANTAÇÃO ser segura: o código sobe antes do DDL, e com a flag ausente
 * nada toca a tabela nova. Env de BACKEND — liga com restart, sem rebuild.
 */
export function isSaleTimelineEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SALE_TIMELINE_ENABLED === "1";
}

/**
 * Registra um evento. Retorna `void` e NUNCA lança: o chamador está sempre
 * pós-commit, e estourar aqui não desfaria nada — só derrubaria o fluxo.
 */
export function recordSaleEvent(input: RecordSaleEventInput): void {
  if (!isSaleTimelineEnabled()) return;
  void gravar(input).catch((err) => {
    console.warn(
      "[SaleTimeline] Falha ao registrar evento da venda (ignorado):",
      err,
    );
  });
}

async function gravar(input: RecordSaleEventInput): Promise<void> {
  await (prisma as any).receivableEvent.create({
    data: {
      receivableId: input.receivableId,
      userId: input.userId,
      // NULL = ação de sistema. É diferente de "não sabemos quem foi": o
      // caminho automático (cadeia do PDV, job) não tem operador.
      actorId: input.actor?.id ?? null,
      // Snapshot: renomear um colaborador não pode reescrever o passado.
      actorName: input.actor?.name ?? null,
      type: input.type,
      message: input.message,
      details: (input.details ?? null) as never,
    },
  });
}

export interface SaleTimelineEntry {
  id: string;
  type: string;
  message: string | null;
  actorName: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * Timeline de UMA venda, mais recente primeiro.
 *
 * Paginada por `limit`/`before` (cursor por data) — uma venda muito editada não
 * pode virar um payload sem fim. Escopo de tenant no `where`, nunca no caller.
 */
export async function listSaleTimeline(
  receivableId: string,
  userId: string,
  opts?: { limit?: number; before?: Date },
): Promise<SaleTimelineEntry[]> {
  if (!isSaleTimelineEnabled()) return [];
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const rows = await (prisma as any).receivableEvent.findMany({
    where: {
      receivableId,
      userId,
      ...(opts?.before ? { createdAt: { lt: opts.before } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      type: true,
      message: true,
      actorName: true,
      details: true,
      createdAt: true,
    },
  });
  return rows as SaleTimelineEntry[];
}

/**
 * Resumo legível do que mudou numa edição — o "o quê" que a timeline precisa
 * mostrar sem virar um dump do payload.
 *
 * Função PURA para ser testável: comparar valores monetários e nulos tem mais
 * armadilha do que parece (`null` × `undefined` × `0` × `"0.00"`).
 *
 * Só compara os campos que o operador reconhece na tela. Ignora o que ele não
 * editou (chave ausente no payload) — enviar o formulário inteiro é detalhe de
 * implementação, não intenção de mudança.
 */
const CAMPOS_LEGIVEIS: Record<string, string> = {
  totalAmount: "Valor total",
  dueDate: "Vencimento",
  customerId: "Cliente",
  paymentMethod: "Forma de pagamento",
  fineAmount: "Multa",
  finePercent: "Multa (%)",
  interestPercent: "Juros (%)",
  toleranceDays: "Tolerância",
  installments: "Parcelas",
  periodDays: "Periodicidade",
  document: "Documento",
  reason: "Motivo",
  unidadeId: "Unidade",
};

export function diffSaleFields(
  antes: Record<string, unknown>,
  depois: Record<string, unknown>,
): string[] {
  const mudou: string[] = [];
  for (const [campo, rotulo] of Object.entries(CAMPOS_LEGIVEIS)) {
    if (!(campo in depois)) continue; // não foi enviado ⇒ não foi editado
    if (!iguais(antes[campo], depois[campo])) mudou.push(rotulo);
  }
  return mudou;
}

/** `null`/`undefined`/`""` são a mesma ausência; número e string numérica são o mesmo valor. */
function iguais(a: unknown, b: unknown): boolean {
  const vazio = (v: unknown) => v === null || v === undefined || v === "";
  if (vazio(a) && vazio(b)) return true;
  if (vazio(a) !== vazio(b)) return false;
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as never).getTime() === new Date(b as never).getTime();
  }
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}
