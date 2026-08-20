/**
 * O que uma conta de marketplace pode mostrar ao navegador.
 *
 * O PROBLEMA (auditoria de 20/08/2026): as rotas de contas de
 * marketplace (`ml`, `shopee`, `magalu`, `olx`, `facebook`)
 * devolviam a linha inteira de `MarketplaceAccount`, que carrega
 * `accessToken`, `refreshToken`, `appClientId` e `appClientSecret`. Essas rotas
 * são consultadas por cinco telas cada uma — conexão, anúncios, sincronização,
 * criação de produto e publicação em massa —, então as credenciais de cada loja
 * trafegavam para o navegador o tempo todo e ficavam em cache, DevTools e
 * extensões. Nenhuma tela usa esses campos.
 *
 * LISTA DE PERMISSÃO, e não de proibição. A primeira tentativa no projeto foi
 * `({ accessToken: _a, refreshToken: _r, ...rest }) => rest` (OLX e Facebook):
 * remove DOIS campos e deixa passar todo o resto — inclusive `appClientSecret`,
 * que ninguém lembrou de listar, e inclusive qualquer coluna que venha a ser
 * adicionada ao modelo depois. Invertendo a direção, uma coluna nova nasce
 * privada em vez de nascer exposta, e o esquecimento passa a ser seguro.
 *
 * Também é o que a regra 1 de egress do projeto pede: nada de entregar campo
 * que a tela não desenha, em caminho recorrente.
 *
 * Módulo PURO (sem I/O): é uma decisão de contrato, e decisão de contrato se
 * testa sem subir servidor.
 */

/** Os três campos que TODA tela de conta desenha, em qualquer plataforma. */
export interface ContaMarketplaceLinha {
  id: string;
  accountName: string;
  status: string;
}

/**
 * Monta o objeto que sai na resposta.
 *
 * `extras` é o que cada plataforma acrescenta por cima da base — e é explícito
 * na chamada, à vista de quem lê a rota, em vez de escondido num spread:
 *
 *   ML, Magalu   nada além da base
 *   OLX          olxSellerPhone, olxSellerZipcode      (a tela edita os dois)
 *   Facebook     fbCatalogId, fbProductUrlBase          (idem)
 *   Shopee       shopId, externalUserId, shopName, region, merchantName
 *
 * Cada campo dessa lista foi conferido nos consumidores antes de entrar: cortar
 * demais quebraria a tela de conexão tão em silêncio quanto o vazamento.
 */
export function contaMarketplaceVisivel<E extends object>(
  acc: ContaMarketplaceLinha,
  extras?: E,
): ContaMarketplaceLinha & E {
  return {
    id: acc.id,
    accountName: acc.accountName,
    status: acc.status,
    ...((extras ?? {}) as E),
  };
}

/**
 * Campos que nunca podem sair. Existe para os testes afirmarem a regra pelo
 * nome, em vez de repetir literais soltos em cada caso.
 */
export const CAMPOS_SECRETOS_DA_CONTA = [
  "accessToken",
  "refreshToken",
  "appClientId",
  "appClientSecret",
] as const;
