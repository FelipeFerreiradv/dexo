/**
 * Entrega C — Permissões de acesso por página (colaboradores).
 *
 * Fonte única de verdade: os ids abaixo espelham os `id` estáveis do
 * NAV_SECTIONS (components/app-sidebar.tsx). Semântica travada (zero regressão):
 *   - admin/superadmin (sem parentUserId)  → SEMPRE liberado;
 *   - pagePermissions null/ausente         → tudo liberado;
 *   - pagePermissions[pageId] === false     → bloqueado;
 *   - qualquer outro caso                   → liberado.
 *
 * `dashboard` deixou de ser inbloqueável. O curto-circuito existia porque
 * `assertPageAccess` redirecionava sempre para "/" — que É o Dashboard —, então
 * bloqueá-lo geraria loop infinito. Agora o redirect vai para a primeira página
 * liberada (`firstAllowedPage`) e, quando não há nenhuma, para `/sem-acesso`.
 *
 * Compatibilidade: como a UI de permissões nunca enviou a chave `dashboard` no
 * PATCH, todo registro existente tem `perms["dashboard"] === undefined`, que
 * continua significando liberado. Remover o curto-circuito não muda o acesso de
 * nenhum colaborador de hoje.
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
  | "pdv"
  | "mensagens"
  | "mercado-livre"
  | "shopee"
  | "magalu"
  | "olx"
  | "logs"
  | "fiscal";

export interface PageDef {
  id: PageId;
  label: string;
  /**
   * Rota canônica da página. Espelha o `href` do NAV_SECTIONS
   * (components/app-sidebar.tsx) — o sidebar segue sendo a fonte do menu; este
   * campo existe para o redirect do guard não precisar importar um client
   * component de ~900 linhas. O teste tests/page-defs-href-drift.spec.ts
   * garante que as duas tabelas não divirjam.
   */
  href: string;
  /**
   * Variável NEXT_PUBLIC_* que precisa valer "true" para a página existir no
   * build. Isto NÃO é cosmético: com a flag desligada, as páginas fiscais fazem
   * `redirect("/")` e `pdv`/`magalu` fazem `notFound()`. Redirecionar um
   * colaborador para uma delas produziria loop (fiscal) ou 404 (as outras).
   */
  flagEnv?: string;
}

/** Páginas que o admin/superadmin pode ligar/desligar por colaborador. */
export const PAGE_DEFS: PageDef[] = [
  { id: "dashboard", label: "Dashboard", href: "/" },
  { id: "produtos", label: "Produtos", href: "/produtos" },
  { id: "sucatas", label: "Sucatas", href: "/sucatas" },
  { id: "localizacoes", label: "Localizações", href: "/localizacoes" },
  { id: "scan-receber", label: "Receber (scanner)", href: "/scan" },
  { id: "pedidos", label: "Pedidos", href: "/pedidos" },
  { id: "clientes", label: "Clientes", href: "/clientes" },
  { id: "financeiro", label: "Financeiro", href: "/financeiro" },
  {
    id: "pdv",
    label: "PDV Balcão",
    href: "/pdv",
    flagEnv: "NEXT_PUBLIC_PDV_ENABLED",
  },
  { id: "mensagens", label: "Mensagens", href: "/mensagens" },
  {
    id: "mercado-livre",
    label: "Mercado Livre",
    href: "/integracoes/mercado-livre",
  },
  { id: "shopee", label: "Shopee", href: "/integracoes/shopee" },
  {
    id: "magalu",
    label: "Magalu",
    href: "/integracoes/magalu",
    flagEnv: "NEXT_PUBLIC_MAGALU_INTEGRATION_ENABLED",
  },
  {
    id: "olx",
    label: "OLX",
    href: "/integracoes/olx",
    flagEnv: "NEXT_PUBLIC_OLX_INTEGRATION_ENABLED",
  },
  { id: "logs", label: "Logs", href: "/logs" },
  {
    id: "fiscal",
    label: "Notas fiscais",
    href: "/notas-fiscais/nfe",
    flagEnv: "NEXT_PUBLIC_FISCAL_MODULE_ENABLED",
  },
];

/**
 * Destino de quem não tem NENHUMA página liberada. Fora de PAGE_DEFS de
 * propósito: sem PageId, a UI de permissões não consegue desligá-la e o guard
 * nunca a avalia — é o que a torna terminal por construção.
 */
export const NO_ACCESS_HREF = "/sem-acesso";

export type PagePermissions = Record<string, boolean> | null | undefined;

interface AccessUser {
  parentUserId?: string | null;
  role?: string | null;
  pagePermissions?: PagePermissions;
}

/** Regra de acesso a uma página. Ver semântica no topo do arquivo. */
export function hasPageAccess(
  user: AccessUser | null | undefined,
  pageId: string,
): boolean {
  if (!user) return false;
  // Admin/superadmin (sem parentUserId) → acesso total.
  if (!user.parentUserId) return true;
  const perms = user.pagePermissions;
  if (perms == null) return true;
  return perms[pageId] !== false;
}

export function pageHref(pageId: PageId): string {
  return PAGE_DEFS.find((p) => p.id === pageId)?.href ?? NO_ACCESS_HREF;
}

/**
 * A página existe no build atual? Falso quando `flagEnv` está declarada e não
 * vale "true" — nesse caso a rota redireciona ou dá 404, e mandar alguém para
 * lá seria pior que não mandar.
 */
export function isPageRoutable(
  def: PageDef,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!def.flagEnv) return true;
  return env[def.flagEnv] === "true";
}

/**
 * Primeira página, na ordem do menu, que o usuário pode acessar E que existe no
 * build. `null` = nenhuma (o caller manda para NO_ACCESS_HREF).
 *
 * `exclude` serve para nunca devolver a própria página que acabou de ser
 * bloqueada — é metade da prova de que o redirect não entra em loop; a outra
 * metade é o filtro por `hasPageAccess`.
 */
export function firstAllowedPage(
  user: AccessUser | null | undefined,
  opts?: {
    exclude?: PageId;
    env?: Record<string, string | undefined>;
  },
): PageId | null {
  if (!user) return null;
  const env = opts?.env ?? process.env;
  for (const def of PAGE_DEFS) {
    if (opts?.exclude && def.id === opts.exclude) continue;
    if (!isPageRoutable(def, env)) continue;
    if (hasPageAccess(user, def.id)) return def.id;
  }
  return null;
}
