// Gate por USUÁRIO do módulo WhatsApp (plano pago superior).
//
// Dupla camada: flag global NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED (kill-switch
// de deploy) && User.whatsappEnabledAt != null (habilitado por cliente via
// scripts/set-whatsapp-access.ts). A checagem usa SEMPRE o dataOwnerId
// (parentUserId ?? id) — colaboradores herdam o acesso do admin pai, mesmo
// padrão multi-tenant do resto do sistema.
//
// Cache em memória com TTL de 60s espelhando o userCache do auth.middleware
// (mesma janela de staleness aceita para bloqueio de usuário). Serviço
// separado de propósito: NÃO tocamos o middleware de auth.

import prisma from "../../lib/prisma";
import { isWhatsappModuleEnabled } from "./whatsapp-constants";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { enabled: boolean; expiresAt: number }>();

/**
 * true ⇔ flag global ligada E o tenant (dataOwnerId) tem whatsappEnabledAt.
 * Qualquer caminho de WhatsApp (rotas /whatsapp/*, branches wa:/WHATSAPP nas
 * rotas /messages/*, processamento de webhook) DEVE curto-circuitar por aqui.
 */
export async function isWhatsappEnabledFor(
  dataOwnerId: string,
): Promise<boolean> {
  if (!isWhatsappModuleEnabled()) return false;
  if (!dataOwnerId) return false;

  const hit = cache.get(dataOwnerId);
  if (hit && hit.expiresAt > Date.now()) return hit.enabled;

  const user = await prisma.user.findUnique({
    where: { id: dataOwnerId },
    select: { whatsappEnabledAt: true },
  });
  const enabled = Boolean(user?.whatsappEnabledAt);
  cache.set(dataOwnerId, { enabled, expiresAt: Date.now() + CACHE_TTL_MS });
  return enabled;
}

/** Limpa o cache (testes e alterações de acesso em runtime). */
export function clearWhatsappEntitlementCache(): void {
  cache.clear();
}
