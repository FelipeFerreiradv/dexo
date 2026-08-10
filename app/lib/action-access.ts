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

export type ActionId =
  | "pdv.cancelar-venda"
  // Fase 9 do Bitz — o que o AGENTE pode propor escrever. Ver o bloco abaixo.
  | "bitz.criar-produto"
  | "bitz.atualizar-preco"
  | "bitz.ajustar-estoque"
  | "bitz.criar-cliente";

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

  // -------------------------------------------------------------------------
  // ⭐ AS AÇÕES DO BITZ (Fase 9) — e por que elas são chaves PRÓPRIAS.
  //
  // Poderiam ter reusado o acesso à página ("quem entra em Produtos pode mandar
  // o Bitz cadastrar produto"). Não reusam, por uma razão: pedir por escrito a
  // um agente NÃO é a mesma coisa que preencher um formulário. No formulário a
  // pessoa vê os 20 campos, erra num e o navegador reclama; no chat ela escreve
  // uma frase e outra coisa decide o resto. É legítimo um administrador querer
  // que o balconista continue cadastrando peça na tela e não pelo Bitz — e sem
  // chave própria não haveria como expressar isso.
  //
  // A semântica é a da casa: DEFAULT PERMITIR para quem já tem a página. No dia
  // do deploy ninguém perde capacidade nenhuma, e o administrador desliga
  // explicitamente para quem não deve ter. (Decisão do dono em 10/08/2026.)
  //
  // ⚠️ A CHAVE NÃO SUBSTITUI O ACESSO À PÁGINA, SOMA-SE A ELE. O tool-runner
  // exige `scope.can(page)` E `scope.canAction(action)`. Quem não entra em
  // Produtos não cadastra produto pelo Bitz nem com a chave ligada.
  // -------------------------------------------------------------------------
  {
    id: "bitz.criar-produto",
    label: "Bitz: cadastrar peça",
    hint: "Deixa o Bitz preparar o cadastro de uma peça nova. Nada é salvo sem o clique de confirmação.",
  },
  {
    id: "bitz.atualizar-preco",
    label: "Bitz: alterar preço de peça",
    hint: "Deixa o Bitz preparar a troca do preço de venda. ATENÇÃO: se a peça tiver anúncio, o preço muda no Mercado Livre e na Shopee assim que for confirmado.",
  },
  {
    id: "bitz.ajustar-estoque",
    label: "Bitz: ajustar estoque de peça",
    hint: "Deixa o Bitz preparar a correção da quantidade em estoque. ATENÇÃO: o estoque é lido pelos marketplaces e altera o que fica disponível para venda.",
  },
  {
    id: "bitz.criar-cliente",
    label: "Bitz: cadastrar cliente",
    hint: "Deixa o Bitz preparar o cadastro de um cliente novo. Nada é salvo sem o clique de confirmação.",
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
