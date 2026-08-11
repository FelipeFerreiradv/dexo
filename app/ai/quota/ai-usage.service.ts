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
  getAiMaxDailyAnexoPerTenant,
  getAiMaxDailyAudioPerTenant,
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

/** Linha de quota da TRANSCRIÇÃO daquele tenant. */
export function audioUsageProvider(dataOwnerId: string): string {
  return `${AI_CONSTANTS.USAGE_PROVIDER_AUDIO_PREFIX}${dataOwnerId}`;
}

/**
 * Reserva uma TRANSCRIÇÃO. Contador próprio, teto próprio.
 *
 * ⭐ POR QUE NÃO REUSAR O CONTADOR DE MENSAGENS: transcrever não é enviar. O
 * lojista fala, lê o que saiu, corrige e só então manda — e gravar duas ou três
 * vezes até sair direito é o comportamento normal, não abuso. Debitar uma
 * mensagem por tentativa gastaria a cota do dia sem ele ter perguntado nada.
 *
 * Mas o teto GLOBAL é o mesmo, e de propósito: ele é a proteção da carteira da
 * plataforma, e áudio custa igual (ou mais) que texto. Transcrição sem teto
 * global seria uma porta aberta ao lado de uma porta trancada.
 */
export async function reserveAiTranscription(input: {
  dataOwnerId: string;
  db?: any;
  now?: Date;
  maxPerTenant?: number;
  maxGlobal?: number;
}): Promise<AiQuotaResult> {
  const { dataOwnerId, db, now } = input;
  if (!dataOwnerId) return { ok: false, denied: "tenant" };

  const maxTenant = input.maxPerTenant ?? getAiMaxDailyAudioPerTenant();
  const maxGlobal = input.maxGlobal ?? getAiMaxDailyGlobal();
  const provider = audioUsageProvider(dataOwnerId);

  let tenantOk = false;
  try {
    tenantOk = await tryReserveDailySlot({
      provider,
      maxPerDay: maxTenant,
      db,
      now,
    });
  } catch {
    // Fail-closed, igual ao turno: erro de banco NEGA em vez de deixar passar
    // sem contar.
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
    // Mesmo `now` da reserva: sem isso, uma virada de meia-noite UTC entre
    // reservar e devolver decrementaria o contador do dia NOVO.
    await refundDailySlot({ provider, db, now });
    return { ok: false, denied: "global" };
  }

  return { ok: true };
}

/** Devolve uma transcrição reservada que NÃO chegou a custar nada. */
export async function refundAiTranscription(input: {
  dataOwnerId: string;
  db?: any;
  now?: Date;
}): Promise<void> {
  await refundDailySlot({
    provider: audioUsageProvider(input.dataOwnerId),
    db: input.db,
    now: input.now,
  });
  await refundDailySlot({
    provider: AI_CONSTANTS.USAGE_PROVIDER_GLOBAL,
    db: input.db,
    now: input.now,
  });
}

/** Linha de quota da leitura de ANEXO daquele tenant. */
export function anexoUsageProvider(dataOwnerId: string): string {
  return `${AI_CONSTANTS.USAGE_PROVIDER_ANEXO_PREFIX}${dataOwnerId}`;
}

/**
 * Reserva uma leitura de ANEXO. Contador próprio, teto próprio.
 *
 * ⭐ SÓ É CHAMADA NO CAMINHO PAGO. Ler um XML de NF-e não passa por aqui, porque
 * não chama modelo nenhum — quem lê é o `parseNfeXml`, puro e local. Debitar
 * uma leitura gratuita seria cobrar do cliente uma conta que a plataforma não
 * pagou, e um desmonte que recebe vinte notas num dia bateria num teto sem ter
 * gasto um centavo. Aquele caminho é contido pelo rate limit da rota e pelo teto
 * de bytes.
 *
 * O teto GLOBAL é o mesmo do resto, e de propósito: ele protege a carteira da
 * plataforma, e imagem custa igual ou mais que texto.
 */
export async function reserveAiAnexo(input: {
  dataOwnerId: string;
  db?: any;
  now?: Date;
  maxPerTenant?: number;
  maxGlobal?: number;
}): Promise<AiQuotaResult> {
  const { dataOwnerId, db, now } = input;
  if (!dataOwnerId) return { ok: false, denied: "tenant" };

  const maxTenant = input.maxPerTenant ?? getAiMaxDailyAnexoPerTenant();
  const maxGlobal = input.maxGlobal ?? getAiMaxDailyGlobal();
  const provider = anexoUsageProvider(dataOwnerId);

  let tenantOk = false;
  try {
    tenantOk = await tryReserveDailySlot({
      provider,
      maxPerDay: maxTenant,
      db,
      now,
    });
  } catch {
    // Fail-closed: erro de banco NEGA em vez de deixar passar sem contar.
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
    // Mesmo `now` da reserva: sem isso, uma virada de meia-noite UTC entre
    // reservar e devolver decrementaria o contador do dia NOVO.
    await refundDailySlot({ provider, db, now });
    return { ok: false, denied: "global" };
  }

  return { ok: true };
}

/** Devolve uma leitura de anexo reservada que NÃO chegou a custar nada. */
export async function refundAiAnexo(input: {
  dataOwnerId: string;
  db?: any;
  now?: Date;
}): Promise<void> {
  await refundDailySlot({
    provider: anexoUsageProvider(input.dataOwnerId),
    db: input.db,
    now: input.now,
  });
  await refundDailySlot({
    provider: AI_CONSTANTS.USAGE_PROVIDER_GLOBAL,
    db: input.db,
    now: input.now,
  });
}

/** Mensagem que o usuário lê quando o teto de ANEXO bate. */
export function anexoQuotaMessage(denied: AiQuotaDenial): string {
  return denied === "tenant"
    ? "Você atingiu o limite de fotos por hoje. Pode escrever a pergunta — isso continua liberado."
    : "O Bitz está com muita demanda agora. Tenta de novo mais tarde.";
}

/** Mensagem que o usuário lê quando o teto de TRANSCRIÇÃO bate. */
export function audioQuotaMessage(denied: AiQuotaDenial): string {
  return denied === "tenant"
    ? "Você atingiu o limite de áudios por hoje. Pode escrever a pergunta — isso continua liberado."
    : "O Bitz está com muita demanda agora. Tenta de novo mais tarde.";
}

/** Mensagem que o usuário lê quando o teto bate. */
export function quotaMessage(denied: AiQuotaDenial): string {
  return denied === "tenant"
    ? "Você atingiu o limite de mensagens do Bitz por hoje. Ele volta amanhã."
    : "O Bitz está com muita demanda agora. Tenta de novo mais tarde.";
}
