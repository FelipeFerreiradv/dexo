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
  | "bitz.criar-produto-lote"
  | "bitz.atualizar-preco"
  | "bitz.ajustar-estoque"
  | "bitz.criar-cliente"
  | "bitz.criar-sucata"
  | "bitz.vincular-sucata"
  | "bitz.pausar-anuncio"
  | "bitz.fiscal-sucata"
  // Fase 11 — ensinar uma regra da loja ao Bitz. Ver a nota em ACTION_DEFS.
  | "bitz.lembrar";

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
    id: "bitz.criar-produto-lote",
    label: "Bitz: cadastrar VÁRIAS peças de uma vez",
    hint: "Deixa o Bitz preparar o cadastro de um lote de peças (um carro desmontado, por exemplo). Chave separada da de peça única de propósito: conferir 25 linhas cansa, e confirmar sem ler é o risco real.",
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
  {
    id: "bitz.criar-sucata",
    label: "Bitz: dar entrada em sucata",
    hint: "Deixa o Bitz preparar a entrada de um veículo comprado para desmontar. A sucata nasce vazia — nenhuma peça é criada. Nada é salvo sem o clique de confirmação.",
  },
  {
    id: "bitz.fiscal-sucata",
    label: "Bitz: preencher a nota fiscal da sucata",
    hint: "Deixa o Bitz copiar para o cadastro do lote os dados da NF-e do veículo (chave, CNPJ, número, série, data, ICMS). Não emite nem altera nota nenhuma.",
  },
  {
    id: "bitz.pausar-anuncio",
    label: "Bitz: pausar / reativar anúncio",
    hint: "Deixa o Bitz preparar a pausa ou a reativação dos anúncios de uma peça. ATENÇÃO: ao confirmar, a peça sai do ar (ou volta) no marketplace na hora. A OLX fica de fora do pausar, porque lá pausar exclui o anúncio.",
  },
  {
    id: "bitz.vincular-sucata",
    label: "Bitz: dizer de qual sucata a peça veio",
    hint: "Deixa o Bitz preparar o vínculo entre uma peça e o lote de onde ela saiu. Não mexe em preço, estoque nem anúncio — só na origem da peça. Exige acesso a Produtos E a Sucatas.",
  },
  // ⚠️ ESTA CHAVE NÃO LIBERA COLABORADOR, e a nota está aqui para ninguém achar
  // que libera. Ensinar uma regra é privativo do ADMINISTRADOR (decisão do dono
  // em 10/08/2026): o que se ensina vale para a equipe inteira, em todo turno de
  // todo mundo, e o balconista reescreveria a regra do dono para o dono. A trava
  // real é `scope.isAdmin`, dentro da tool.
  //
  // A chave existe porque TODA tool de escrita declara a sua permissão — o
  // tool-runner barra `kind: "write"` sem `action`, e um teste de contrato exige
  // que a declarada esteja aqui. Ela também é o encaixe pronto para o dia em que
  // um cliente quiser deixar o gerente ensinar.
  {
    id: "bitz.lembrar",
    label: "Bitz: ensinar uma regra da loja",
    hint: "Ensinar o Bitz é do administrador da conta — esta chave não libera colaborador. As regras ensinadas valem para toda a equipe.",
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
