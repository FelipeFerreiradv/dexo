// Teto DIÁRIO de mensagens do Bitz — por tenant e global.
//
// REUSA `tryReserveDailySlot`/`refundDailySlot` do pipeline de imagem em vez de
// reescrever: aquele incremento condicional (`updateMany where count < max`) é
// atômico no Postgres, sobrevive a pm2 restart, vale entre processos e resolve
// a corrida do "primeiro do dia" pelo unique(provider, day). É lógica sutil e
// já testada — duplicá-la seria criar um segundo lugar para errar.
//
// A tabela ProviderDailyUsage é chaveada por (provider, day) com `provider`
// livre. Usamos duas linhas por dia:
//   ai:global               -> teto da plataforma inteira
//   ai:tenant:<dataOwnerId> -> teto do cliente
// Zero migração, zero tabela nova.
//
// Ordem: TENANT primeiro, GLOBAL depois. O teto do tenant é o que bate na
// prática; falhar nele evita mexer no contador global. Se o global falhar
// depois, o do tenant é devolvido — senão um cliente perderia cota por causa
// de um teto que nem é dele.

import {
  refundDailySlot,
  tryReserveDailySlot,
} from "../../marketplaces/services/rembg-provider-usage";
import {
  AI_CONSTANTS,
  getAiMaxDailyGlobal,
  getAiMaxDailyPerTenant,
} from "../core/ai-constants";

export type AiQuotaDenial = "tenant" | "global";

export interface AiQuotaResult {
  ok: boolean;
  /** Qual teto barrou. Só presente quando ok=false. */
  denied?: AiQuotaDenial;
}

export interface ReserveAiTurnInput {
  dataOwnerId: string;
  /** Injetável para teste — mesmo padrão de rembg-provider-usage. */
  db?: any;
  now?: Date;
  maxPerTenant?: number;
  maxGlobal?: number;
}

export function tenantUsageProvider(dataOwnerId: string): string {
  return `${AI_CONSTANTS.USAGE_PROVIDER_TENANT_PREFIX}${dataOwnerId}`;
}

/**
 * Reserva um turno. Pessimista: incrementa ANTES de chamar o provedor, então o
 * gasto real nunca passa do teto (pode ficar até `falhas` abaixo dele).
 *
 * Fail-closed: erro de banco no contador NEGA o turno em vez de deixar passar
 * sem contar — mesma decisão do pipeline de imagem.
 */
export async function reserveAiTurn(
  input: ReserveAiTurnInput,
): Promise<AiQuotaResult> {
  const { dataOwnerId, db, now } = input;
  if (!dataOwnerId) return { ok: false, denied: "tenant" };

  const maxTenant = input.maxPerTenant ?? getAiMaxDailyPerTenant();
  const maxGlobal = input.maxGlobal ?? getAiMaxDailyGlobal();
  const tenantProvider = tenantUsageProvider(dataOwnerId);

  let tenantOk = false;
  try {
    tenantOk = await tryReserveDailySlot({
      provider: tenantProvider,
      maxPerDay: maxTenant,
      db,
      now,
    });
  } catch {
    return { ok: false, denied: "tenant" };
  }
  if (!tenantOk) return { ok: false, denied: "tenant" };

  let globalOk = false;
  try {
    globalOk = await tryReserveDailySlot({
      provider: AI_CONSTANTS.USAGE_PROVIDER_GLOBAL,
      maxPerDay: maxGlobal,
      db,
      now,
    });
  } catch {
    globalOk = false;
  }

  if (!globalOk) {
    // Devolve o slot do tenant: ele não gastou nada, o teto global é que fechou.
    // `now` é o MESMO da reserva de propósito — sem isso, uma virada de meia-
    // noite UTC entre reservar e devolver decrementaria o contador do dia novo.
    await refundDailySlot({ provider: tenantProvider, db, now });
    return { ok: false, denied: "global" };
  }

  return { ok: true };
}

/**
 * Devolve um turno reservado que NÃO virou chamada ao provedor (ex.: nem havia
 * provedor configurado). Best-effort — nunca lança.
 */
export async function refundAiTurn(input: {
  dataOwnerId: string;
  db?: any;
  now?: Date;
}): Promise<void> {
  await refundDailySlot({
    provider: tenantUsageProvider(input.dataOwnerId),
    db: input.db,
    now: input.now,
  });
  await refundDailySlot({
    provider: AI_CONSTANTS.USAGE_PROVIDER_GLOBAL,
    db: input.db,
    now: input.now,
  });
}

/** Mensagem que o usuário lê quando o teto bate. */
export function quotaMessage(denied: AiQuotaDenial): string {
  return denied === "tenant"
    ? "Você atingiu o limite de mensagens do Bitz por hoje. Ele volta amanhã."
    : "O Bitz está com muita demanda agora. Tenta de novo mais tarde.";
}
