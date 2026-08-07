// Gate por USUÁRIO do módulo Bitz (agente de IA, plano pago superior).
//
// Dupla camada: flag global NEXT_PUBLIC_AI_MODULE_ENABLED (kill-switch de
// deploy) && User.aiEnabledAt != null (habilitado por cliente via
// scripts/set-ai-access.ts). A checagem usa SEMPRE o dataOwnerId
// (parentUserId ?? id) — colaboradores herdam o acesso do admin pai, mesmo
// padrão multi-tenant do resto do sistema.
//
// Cache em memória com TTL de 60s espelhando o userCache do auth.middleware
// (mesma janela de staleness aceita para bloqueio de usuário). Serviço
// separado de propósito: NÃO tocamos o middleware de auth nem o gate do
// WhatsApp — são dois irmãos independentes, não uma abstração compartilhada.

import prisma from "../../lib/prisma";
import { isAiModuleEnabled } from "../core/ai-constants";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { enabled: boolean; expiresAt: number }>();

/**
 * true ⇔ flag global ligada E o tenant (dataOwnerId) tem aiEnabledAt.
 * TODA rota /ai/* e todo caminho do agente DEVE curto-circuitar por aqui.
 * Fail-closed: usuário inexistente, id vazio ou coluna NULL ⇒ false.
 */
export async function isAiEnabledFor(dataOwnerId: string): Promise<boolean> {
  if (!isAiModuleEnabled()) return false;
  if (!dataOwnerId) return false;

  const hit = cache.get(dataOwnerId);
  if (hit && hit.expiresAt > Date.now()) return hit.enabled;

  const user = await prisma.user.findUnique({
    where: { id: dataOwnerId },
    select: { aiEnabledAt: true },
  });
  const enabled = Boolean(user?.aiEnabledAt);
  cache.set(dataOwnerId, { enabled, expiresAt: Date.now() + CACHE_TTL_MS });
  return enabled;
}

/** Limpa o cache (testes e alterações de acesso em runtime). */
export function clearAiEntitlementCache(): void {
  cache.clear();
}
