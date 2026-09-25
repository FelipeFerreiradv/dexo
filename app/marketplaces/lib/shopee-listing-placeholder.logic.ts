/**
 * O item_id da Shopee contido num `externalListingId` (`123` ou `123:456`,
 * item:model). É o parse que o sync de estoque usa para montar a chamada — mora
 * aqui para o predicado abaixo e o sync lerem a MESMA regra, e não duas cópias
 * que podem divergir. Pode devolver NaN, 0 ou negativo: quem decide se o número
 * serve é `isShopeeListingPlaceholder`.
 */
export function parseShopeeItemId(externalListingId: string): number {
  return parseInt(externalListingId.split(":")[0], 10);
}

/**
 * O `externalListingId` de um anúncio da Shopee é um MARCADOR local, e não um
 * item_id da Shopee?
 *
 * Quando a criação do anúncio falha, a Dexo grava `PENDING_SHP_<timestamp>`
 * no lugar do item_id (listing.usercase) para o ListingRetryService tentar de
 * novo depois. Esse texto não existe na Shopee: mandar ele para qualquer
 * endpoint vira `item_id_list=NaN` e volta `strconv.ParseUint: parsing "NaN"`.
 * Em 10 dias foram 423 FAILURE de estoque assim em 20 contas — parte delas já
 * 429 "Too many requests", porque as chamadas inúteis gastam a cota da conta.
 *
 * A regra espelha o parse que o sync de estoque usa para montar a chamada
 * (`parseInt(id.split(":")[0], 10)`), de propósito: é marcador exatamente o id
 * que NÃO produziria um item_id utilizável. Tudo o que produz um número
 * positivo — `123`, `123:456` (item:model), ` 123 ` com espaço — segue para a
 * Shopee como antes. `PENDING_` é conferido explicitamente para documentar a
 * origem e para não depender do parse se o formato do marcador mudar.
 *
 * Pura: sem banco, sem rede (regra de egress 5).
 */
export function isShopeeListingPlaceholder(externalListingId: unknown): boolean {
  if (externalListingId === null || externalListingId === undefined) {
    return true;
  }
  const texto = String(externalListingId);
  if (texto.startsWith("PENDING_")) return true;
  const itemId = parseShopeeItemId(texto);
  return !Number.isFinite(itemId) || itemId <= 0;
}
