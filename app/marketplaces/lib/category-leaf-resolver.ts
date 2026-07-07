/**
 * Resolve a "moda" de categoria da base interna (CatalogStat) — que pode apontar
 * para um NÓ-PAI — para uma FOLHA válida da árvore local sincronizada, reusando
 * a MESMA descida que o publish já aplica (CategoryResolutionService
 * .ensureLeafLocalOnly: "outros"/primeiro filho). Assim a sugestão exibida passa
 * a ser a mesma folha que seria publicada — completa em vez de um pai inválido.
 *
 * Funções puras com deps injetáveis → testáveis sem prisma. Fail-safe: qualquer
 * lookup vazio (ou exceção) mantém o valor original — nunca piora o que já acerta.
 */

const SHOPEE_PREFIX = "SHP_";

export interface MlLeafDeps {
  /** cuid (MarketplaceCategory.id) → categoria (traz externalId). */
  findById: (cuid: string) => Promise<{ externalId: string | null } | null>;
  /** externalId → folha local (mesma descida do publish). */
  ensureLeaf: (externalId: string) => Promise<{ externalId: string } | null>;
  /** externalId da folha → categoria (traz o cuid de volta). */
  findByExternalId: (externalId: string) => Promise<{ id: string } | null>;
}

export interface ShopeeLeafDeps {
  ensureLeaf: (externalId: string) => Promise<{ externalId: string } | null>;
}

/**
 * ML: a moda é um cuid (FK `MarketplaceCategory.id`). Converte cuid→externalId,
 * desce até a folha e volta ao cuid. Já-folha (ou qualquer elo ausente) → mantém
 * o cuid original.
 */
export async function mlModeToLeafCuid(
  modeCuid: string,
  deps: MlLeafDeps,
): Promise<string> {
  try {
    const cat = await deps.findById(modeCuid);
    if (!cat?.externalId) return modeCuid;
    const leaf = await deps.ensureLeaf(cat.externalId);
    // Sem folha diferente (já é folha) → não precisa reconverter.
    if (!leaf?.externalId || leaf.externalId === cat.externalId) return modeCuid;
    const leafCat = await deps.findByExternalId(leaf.externalId);
    return leafCat?.id ?? modeCuid;
  } catch {
    return modeCuid;
  }
}

/**
 * Shopee: a moda é o id numérico puro (ex.: "102231"); a árvore usa externalId
 * "SHP_<id>". Desce até a folha e devolve o id puro. Já-folha (ou categoria
 * ausente) → mantém o id original.
 */
export async function shopeeModeToLeafId(
  modeId: string,
  deps: ShopeeLeafDeps,
): Promise<string> {
  try {
    const leaf = await deps.ensureLeaf(`${SHOPEE_PREFIX}${modeId}`);
    if (!leaf?.externalId) return modeId;
    return leaf.externalId.startsWith(SHOPEE_PREFIX)
      ? leaf.externalId.slice(SHOPEE_PREFIX.length)
      : leaf.externalId;
  } catch {
    return modeId;
  }
}
