// Gate por USUÁRIO do módulo Bitz (agente de IA) e teto diário por tenant.
//
// TRÊS CAMADAS, nesta ordem:
//   1. NEXT_PUBLIC_AI_MODULE_ENABLED — kill-switch de deploy. Desligado, nada
//      passa, nem prévia nem concessão.
//   2. AI_FREE_PREVIEW              — prévia gratuita: vale para todo mundo.
//   3. User.aiEnabledAt             — concessão individual (plano pago).
//
// A checagem usa SEMPRE o dataOwnerId (parentUserId ?? id) — colaboradores
// herdam do admin pai, mesmo padrão multi-tenant do resto do sistema.
//
// Cache em memória com TTL de 60s espelhando o userCache do auth.middleware
// (mesma janela de staleness aceita para bloqueio de usuário). Serviço
// separado de propósito: NÃO tocamos o middleware de auth nem o gate do
// WhatsApp — são dois irmãos independentes, não uma abstração compartilhada.

import prisma from "../../lib/prisma";
import {
  isAiFreePreviewEnabled,
  isAiModuleEnabled,
} from "../core/ai-constants";

const CACHE_TTL_MS = 60_000;

interface Entrada {
  enabled: boolean;
  /** Teto próprio do tenant. null = usa o padrão global. */
  dailyLimit: number | null;
  expiresAt: number;
}

const cache = new Map<string, Entrada>();

/**
 * Lê o usuário uma vez e guarda as DUAS informações — acesso e teto.
 *
 * ⚠️ Uma consulta só, de propósito: o gate roda em toda rota /ai/* e o teto é
 * lido no mesmo turno. Dois `findUnique` seriam duas idas ao banco por
 * mensagem, para ler duas colunas da mesma linha.
 */
async function ler(dataOwnerId: string): Promise<Entrada> {
  const hit = cache.get(dataOwnerId);
  if (hit && hit.expiresAt > Date.now()) return hit;

  let concedido = false;
  let dailyLimit: number | null = null;
  try {
    const user = await prisma.user.findUnique({
      where: { id: dataOwnerId },
      select: { aiEnabledAt: true, aiDailyLimit: true },
    });
    concedido = Boolean(user?.aiEnabledAt);
    dailyLimit =
      typeof user?.aiDailyLimit === "number" && user.aiDailyLimit >= 0
        ? user.aiDailyLimit
        : null;
  } catch {
    // Fail-closed: banco fora do ar não vira acesso liberado. E não gravamos
    // no cache, para a próxima tentativa consultar de novo.
    return { enabled: false, dailyLimit: null, expiresAt: 0 };
  }

  // ⭐ A PRÉVIA LIBERA O ACESSO, MAS NÃO O TETO — e o `concedido ?` abaixo é a
  // única linha que faz essa regra existir de verdade.
  //
  // ⚠️ ISTO JÁ ESTEVE ERRADO. A primeira versão devolvia `dailyLimit` direto da
  // coluna, sem olhar `concedido`, enquanto este mesmo comentário afirmava a
  // regra. O buraco: revogar um cliente grava `aiEnabledAt = null` e NÃO limpa
  // `aiDailyLimit`. Com a prévia ligada, o ex-assinante voltava pela prévia
  // carregando o teto do plano pago — até 2000 mensagens/dia de graça, ~R$ 18
  // por dia num único tenant, consumindo quase metade do teto global e
  // empurrando os clientes da prévia para "o Bitz está com muita demanda".
  //
  // O teto pertence ao PLANO, não à prévia. Sem concessão, `null` — e `null`
  // significa "usa o padrão da plataforma", resolvido em `reserveAiTurn`.
  const entrada: Entrada = {
    enabled: isAiFreePreviewEnabled() || concedido,
    dailyLimit: concedido ? dailyLimit : null,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  cache.set(dataOwnerId, entrada);
  return entrada;
}

/**
 * true ⇔ módulo ligado E (prévia gratuita OU o tenant tem aiEnabledAt).
 * TODA rota /ai/* e todo caminho do agente DEVE curto-circuitar por aqui.
 * Fail-closed: usuário inexistente, id vazio ou banco fora ⇒ false.
 */
export async function isAiEnabledFor(dataOwnerId: string): Promise<boolean> {
  if (!isAiModuleEnabled()) return false;
  if (!dataOwnerId) return false;
  return (await ler(dataOwnerId)).enabled;
}

/**
 * Teto diário PRÓPRIO deste tenant, ou null para usar o padrão global.
 *
 * Quem decide o que fazer com o null é `reserveAiTurn` — aqui não se lê env
 * nenhuma, para haver um único lugar no sistema onde o padrão é resolvido.
 */
export async function getAiDailyLimitFor(
  dataOwnerId: string,
): Promise<number | null> {
  if (!dataOwnerId) return null;
  return (await ler(dataOwnerId)).dailyLimit;
}

/** Limpa o cache (testes e alterações de acesso em runtime). */
export function clearAiEntitlementCache(): void {
  cache.clear();
}
