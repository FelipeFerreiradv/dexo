/**
 * Entrega C — Permissões de acesso por página (colaboradores).
 *
 * Fonte única de verdade: os ids abaixo espelham os `id` estáveis do
 * NAV_SECTIONS (components/app-sidebar.tsx). Semântica travada (zero regressão):
 *   - admin/superadmin (sem parentUserId)  → SEMPRE liberado;
 *   - `dashboard`                          → SEMPRE liberado (evita loop de
 *     redirect, pois '/' é o alvo de redirect das páginas bloqueadas);
 *   - pagePermissions null/ausente         → tudo liberado;
 *   - pagePermissions[pageId] === false     → bloqueado;
 *   - qualquer outro caso                   → liberado.
 */

export type PageId =
  | "dashboard"
  | "produtos"
  | "sucatas"
  | "localizacoes"
  | "scan-receber"
  | "pedidos"
  | "clientes"
  | "financeiro"
  | "mensagens"
  | "mercado-livre"
  | "shopee"
  | "magalu"
  | "olx"
  | "logs"
  | "fiscal";

/** Páginas que o admin/superadmin pode ligar/desligar por colaborador. */
export const PAGE_DEFS: { id: PageId; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "produtos", label: "Produtos" },
  { id: "sucatas", label: "Sucatas" },
  { id: "localizacoes", label: "Localizações" },
  { id: "scan-receber", label: "Receber (scanner)" },
  { id: "pedidos", label: "Pedidos" },
  { id: "clientes", label: "Clientes" },
  { id: "financeiro", label: "Financeiro" },
  { id: "mensagens", label: "Mensagens" },
  { id: "mercado-livre", label: "Mercado Livre" },
  { id: "shopee", label: "Shopee" },
  { id: "magalu", label: "Magalu" },
  { id: "olx", label: "OLX" },
  { id: "logs", label: "Logs" },
  { id: "fiscal", label: "Notas fiscais" },
];

export type PagePermissions = Record<string, boolean> | null | undefined;

interface AccessUser {
  parentUserId?: string | null;
  role?: string | null;
  pagePermissions?: PagePermissions;
}

/**
 * Regra de acesso a uma página. Ver semântica no topo do arquivo.
 * `dashboard` nunca é bloqueável (alvo seguro de redirect).
 */
export function hasPageAccess(
  user: AccessUser | null | undefined,
  pageId: string,
): boolean {
  if (!user) return false;
  // Admin/superadmin (sem parentUserId) → acesso total.
  if (!user.parentUserId) return true;
  // Dashboard sempre acessível (anti-loop de redirect).
  if (pageId === "dashboard") return true;
  const perms = user.pagePermissions;
  if (perms == null) return true;
  return perms[pageId] !== false;
}
