/**
 * Rótulo de exibição de uma conta Shopee.
 *
 * O PROBLEMA: a Shopee era a única plataforma que gravava um IDENTIFICADOR onde
 * as outras gravam um NOME. O Mercado Livre já fazia o certo desde sempre
 * (`accountName: userInfo.nickname || userInfo.email`), e a Shopee gravava
 * `Shopee Shop 1547916297`. Como ~20 telas leem `MarketplaceAccount.accountName`
 * — anúncios, sincronização, criação de produto, revisão em massa, mensagens,
 * pedidos, notas fiscais, dashboard —, o operador com três lojas conectadas
 * tinha de decorar números para saber em qual estava mexendo.
 *
 * Medido em 20/08/2026: 35 de 35 contas Shopee em produção usavam o rótulo
 * genérico.
 *
 * A CORREÇÃO É NA ORIGEM. Espalhar o nome da loja por 20 componentes seria 20
 * arquivos, cada um com o seu fetch e o seu fallback. Corrigindo `accountName`,
 * todas as telas passam a mostrar o nome sem que nenhuma mude uma linha.
 *
 * Seguro por construção: `accountName` NÃO é chave — as unicidades de
 * `MarketplaceAccount` são `[platform, externalUserId]` e `[platform, shopId]` —
 * e nenhum código do repositório casa pela string "Shopee Shop" (só a gravação
 * e dois fixtures de teste).
 *
 * Módulo PURO (sem I/O), para o formato ser testável sem tocar na API da Shopee.
 */

/** Rótulo de quando NÃO se descobriu o nome da loja. É o formato histórico. */
export function shopeeFallbackAccountName(shopId: number | string): string {
  return `Shopee Shop ${shopId}`;
}

/**
 * Reconhece o rótulo genérico `Shopee Shop <id>`.
 *
 * É esta função que protege um nome escolhido a dedo: o backfill e a auto-cura
 * só escrevem por cima do genérico. Uma conta já renomeada nunca é sobrescrita
 * por um refresh.
 */
export function isGenericShopeeAccountName(
  accountName: string | null | undefined,
): boolean {
  return /^Shopee Shop \d+$/.test((accountName ?? "").trim());
}

/**
 * Monta o rótulo a partir do `shop_name` da Shopee.
 *
 * Decisões:
 *  - o prefixo "SHOPEE" é sempre visível, para o operador não confundir a loja
 *    com uma conta de outro canal que tenha nome parecido;
 *  - a marca NÃO é duplicada: loja chamada "Shopee Autopeças" vira
 *    "SHOPEE Autopeças", nunca "SHOPEE Shopee Autopeças";
 *  - a caixa do nome da loja é PRESERVADA. Só o prefixo é maiúsculo. Forçar
 *    tudo em caixa alta destruiria informação que veio da Shopee, e é a única
 *    parte deste módulo que não dá para desfazer depois;
 *  - nome vazio/ausente cai no fallback histórico, então uma falha na API nunca
 *    deixa a conta sem rótulo nenhum.
 */
export function shopeeAccountLabel(
  shopName: string | null | undefined,
  shopId: number | string,
): string {
  const nome = (shopName ?? "").trim();
  if (!nome) return shopeeFallbackAccountName(shopId);
  // Já começa com a marca: normaliza só o prefixo e mantém o resto intacto.
  if (/^shopee\b/i.test(nome)) return `SHOPEE${nome.slice("shopee".length)}`;
  return `SHOPEE ${nome}`;
}

/**
 * O rótulo que a conta DEVERIA ter, ou `null` se nada deve mudar.
 *
 * Uma função só porque a regra vale em dois lugares — a auto-cura dentro do
 * `GET /shopee/accounts` e o script de backfill — e duas cópias de um `if`
 * composto divergem no primeiro ajuste. As duas condições são necessárias:
 *
 *  - só o rótulo GENÉRICO é substituível, senão um refresh apagaria o nome que
 *    alguém escolheu à mão;
 *  - o rótulo calculado tem de DIFERIR do atual, senão a conta cujo
 *    `get_shop_info` veio vazio sofreria um UPDATE por ciclo, para gravar
 *    exatamente o que já estava lá.
 */
export function nextShopeeAccountName(
  accountNameAtual: string | null | undefined,
  shopName: string | null | undefined,
  shopId: number | string,
): string | null {
  if (!isGenericShopeeAccountName(accountNameAtual)) return null;
  const rotulo = shopeeAccountLabel(shopName, shopId);
  return rotulo === (accountNameAtual ?? "") ? null : rotulo;
}
