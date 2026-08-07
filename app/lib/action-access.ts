/**
 * Permissão por AÇÃO (Bloco E).
 *
 * O sistema sempre teve permissão por PÁGINA (`pagePermissions` +
 * `app/lib/page-access.ts`). Isto acrescenta granularidade por ação sem tocar
 * naquele arquivo — que é lido pelo guard de navegação, pelo sidebar e por dois
 * specs (`guard-page.spec.ts`, `first-allowed-page.spec.ts`).
 *
 * ONDE MORA: no MESMO `User.pagePermissions Json?`, com as chaves prefixadas
 * por `action:`. Não há coluna nova, e `sanitizePagePermissions`
 * (team.routes.ts:151-164) já aceita qualquer chave booleana — então o
 * POST/PATCH de colaborador não muda em nada.
 *
 * SEMÂNTICA (idêntica à de página, decisão aprovada em 06/08):
 *  - admin/superadmin (sem `parentUserId`) → SEMPRE pode;
 *  - `pagePermissions` null/ausente → pode;
 *  - `pagePermissions["action:<id>"] === false` → NÃO pode;
 *  - qualquer outro caso → pode.
 *
 * O default é PERMITIR justamente para não regredir: no dia em que isto entrar,
 * nenhum colaborador que hoje consegue cancelar uma venda perde a capacidade. O
 * administrador desliga explicitamente para quem não deve ter.
 */

export type ActionId = "pdv.cancelar-venda";

export interface ActionDef {
  id: ActionId;
  label: string;
  hint: string;
}

export const ACTION_DEFS: ActionDef[] = [
  {
    id: "pdv.cancelar-venda",
    label: "Cancelar / estornar venda",
    hint: "Devolve o estoque, reabre os anúncios e cancela a venda no balcão.",
  },
];

/** Chave usada dentro de `pagePermissions`. O prefixo evita colisão com PageId. */
export function actionPermissionKey(actionId: ActionId): string {
  return `action:${actionId}`;
}

export type PagePermissions = Record<string, boolean> | null | undefined;

interface AccessUser {
  parentUserId?: string | null;
  role?: string | null;
  pagePermissions?: PagePermissions;
}

/** Regra de acesso a uma ação. Ver semântica no topo do arquivo. */
export function hasActionAccess(
  user: AccessUser | null | undefined,
  actionId: ActionId,
): boolean {
  if (!user) return false;
  // Admin/superadmin (sem parentUserId) → sempre.
  if (!user.parentUserId) return true;
  const perms = user.pagePermissions;
  if (perms == null) return true;
  return perms[actionPermissionKey(actionId)] !== false;
}
