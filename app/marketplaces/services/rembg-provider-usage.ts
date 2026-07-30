/**
 * Teto financeiro DIÁRIO do provedor externo de recorte (PR 5).
 *
 * Cada chamada ao provedor externo custa dinheiro; o Felipe aprovou o fallback
 * pago COM teto. O contador vive em banco (`ProviderDailyUsage`, uma linha por
 * provedor+dia UTC) — sobrevive a pm2 restart e vale entre processos, ao
 * contrário de um contador em memória.
 *
 * A reserva é PESSIMISTA: incrementa ANTES de chamar o provedor. Chamada que
 * falha pode ou não ser cobrada pelo fornecedor; contar a tentativa garante
 * que o gasto real NUNCA passa do teto (pode ficar até `falhas` abaixo dele).
 *
 * Concorrência sem transação: increment condicional (count < max) via
 * updateMany é atômico no Postgres; a corrida do "primeiro do dia" (dois
 * creates simultâneos) é resolvida pelo unique(provider, day) + um retry do
 * increment.
 */

import prisma from "../../lib/prisma";

/** Dia UTC ("YYYY-MM-DD") — determinístico e alinhado com o ciclo de cobrança
 *  da maioria dos provedores. Documentado no .env.example. */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface ReserveDailySlotInput {
  provider: string;
  maxPerDay: number;
  /** Injetável para teste. */
  db?: any;
  now?: Date;
}

/** true = slot reservado (pode chamar o provedor); false = teto do dia batido. */
export async function tryReserveDailySlot(
  input: ReserveDailySlotInput,
): Promise<boolean> {
  const { provider, maxPerDay } = input;
  if (!Number.isFinite(maxPerDay) || maxPerDay <= 0) return false;
  const db = input.db ?? (prisma as any);
  const day = utcDayKey(input.now);

  const increment = () =>
    db.providerDailyUsage.updateMany({
      where: { provider, day, count: { lt: maxPerDay } },
      data: { count: { increment: 1 } },
    });

  const first = await increment();
  if (first.count === 1) return true;

  // Nada atualizado: ou a linha do dia não existe ainda, ou o teto já bateu.
  try {
    await db.providerDailyUsage.create({ data: { provider, day, count: 1 } });
    return true;
  } catch {
    // Unique violado = outra requisição criou a linha no meio — o increment
    // condicional decide (e também cobre "linha existe com count >= max").
    const retry = await increment();
    return retry.count === 1;
  }
}

/**
 * Devolve um slot reservado que NÃO virou chamada (ex.: sonda do breaker já
 * tomada por outra requisição). Best-effort — nunca lança.
 */
export async function refundDailySlot(input: {
  provider: string;
  db?: any;
  now?: Date;
}): Promise<void> {
  const db = input.db ?? (prisma as any);
  try {
    await db.providerDailyUsage.updateMany({
      where: {
        provider: input.provider,
        day: utcDayKey(input.now),
        count: { gt: 0 },
      },
      data: { count: { decrement: 1 } },
    });
  } catch (err) {
    console.warn(
      "[rembg-provider-usage] refund falhou (inofensivo, teto fica conservador):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Uso de hoje por provedor (snapshot do /internal/rembg/status). */
export async function getTodayProviderUsage(db?: any): Promise<
  Array<{ provider: string; day: string; count: number }>
> {
  const client = db ?? (prisma as any);
  const rows = await client.providerDailyUsage.findMany({
    where: { day: utcDayKey() },
    select: { provider: true, day: true, count: true },
  });
  return rows;
}
