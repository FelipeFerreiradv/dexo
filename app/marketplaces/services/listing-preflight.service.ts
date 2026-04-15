import {
  MLAttributeCatalogService,
  NormalizedMLAttribute,
} from "./ml-attribute-catalog.service";

export type PreflightSeverity = "block" | "warn";

export interface PreflightIssue {
  code: string;
  field: string;
  severity: PreflightSeverity;
  message: string;
  fixHint?: string;
}

export interface MLPreflightInput {
  product: {
    id?: string;
    name?: string | null;
    brand?: string | null;
    model?: string | null;
    year?: string | null;
    partNumber?: string | null;
    sku?: string | null;
    heightCm?: number | null;
    widthCm?: number | null;
    lengthCm?: number | null;
    weightKg?: any;
    imageUrl?: string | null;
    quality?: string | null;
  };
  categoryId: string;
  currentAttributes: Array<{ id: string; value_name: string }>;
}

export interface MLPreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
  /** Atributos adicionados automaticamente a partir dos campos do produto. */
  enrichedAttributes: Array<{ id: string; value_name: string }>;
  /** Ids obrigatórios que nem o produto nem o enrichment conseguiram satisfazer. */
  missingRequired: string[];
}

/**
 * Mapeamento best-effort de IDs de atributo ML para fields do produto.
 * Usado pelo enrichment para auto-preencher atributos obrigatórios a
 * partir dos campos do domínio, sem exigir mudança no schema do produto.
 */
const ATTR_TO_FIELD: Record<string, (p: MLPreflightInput["product"]) => string | undefined> = {
  PART_NUMBER: (p) => p.partNumber || undefined,
  MPN: (p) => p.partNumber || undefined,
  OEM: (p) => p.partNumber || undefined,
  GTIN: () => undefined,
  BRAND: (p) => p.brand || undefined,
  MODEL: (p) => p.model || undefined,
  YEAR: (p) => p.year || undefined,
  VEHICLE_YEAR: (p) => p.year || undefined,
  SELLER_SKU: (p) => p.sku || undefined,
  ITEM_CONDITION: (p) =>
    p.quality === "NOVO" ? "Novo" : p.quality ? "Usado" : undefined,
};

/**
 * Atributos cuja ausência no produto NÃO bloqueia — são universais
 * (marca genérica, tamanho, cor) e podem ser aceitos como "Não especificado"
 * pelo próprio ML sem rejeição.
 */
const SOFT_REQUIRED = new Set([
  "UNIT_OF_LENGTH",
  "COLOR",
  "MAIN_COLOR",
  "SIZE",
  "LENGTH",
  "WIDTH",
  "HEIGHT",
  "WEIGHT",
]);

export class ListingPreflightService {
  /**
   * Valida/enriquece payload ML antes de chamar a API. Retorna:
   * - enrichedAttributes: lista final para uso no payload (já contém os atuais + auto-preenchidos)
   * - missingRequired: obrigatórios que não foi possível preencher (o caller deve bloquear)
   * - issues: lista classificada (block/warn) para feedback ao usuário
   *
   * Fail-open: se o catálogo de atributos estiver indisponível, retorna ok=true
   * com a lista de atributos inalterada (comportamento atual do sistema).
   */
  static async checkML(input: MLPreflightInput): Promise<MLPreflightResult> {
    const { product, categoryId, currentAttributes } = input;
    const issues: PreflightIssue[] = [];
    const enriched = [...currentAttributes];
    const byId = new Map(enriched.map((a) => [a.id, a]));

    let requiredAttrs: NormalizedMLAttribute[] = [];
    try {
      requiredAttrs = await MLAttributeCatalogService.getRequired(categoryId);
    } catch (err) {
      console.warn(
        `[ListingPreflight] catalog unavailable for ${categoryId}, fail-open:`,
        err instanceof Error ? err.message : String(err),
      );
      return {
        ok: true,
        issues: [],
        enrichedAttributes: enriched,
        missingRequired: [],
      };
    }

    if (requiredAttrs.length === 0) {
      return {
        ok: true,
        issues: [],
        enrichedAttributes: enriched,
        missingRequired: [],
      };
    }

    const missingRequired: string[] = [];

    for (const attr of requiredAttrs) {
      const existing = byId.get(attr.id);
      const hasValue =
        existing &&
        typeof existing.value_name === "string" &&
        existing.value_name.trim().length > 0;
      if (hasValue) continue;

      const filler = ATTR_TO_FIELD[attr.id];
      const fromProduct = filler ? filler(product) : undefined;

      if (fromProduct && fromProduct.trim().length > 0) {
        const newAttr = { id: attr.id, value_name: fromProduct.trim() };
        enriched.push(newAttr);
        byId.set(attr.id, newAttr);
        continue;
      }

      if (SOFT_REQUIRED.has(attr.id)) {
        issues.push({
          code: "soft_missing_attribute",
          field: attr.id,
          severity: "warn",
          message: `Atributo opcional ${attr.name} (${attr.id}) ausente`,
        });
        continue;
      }

      missingRequired.push(attr.id);
      issues.push({
        code: "missing_attribute",
        field: attr.id,
        severity: "block",
        message: `Categoria ${categoryId} exige o atributo "${attr.name}" (${attr.id})`,
        fixHint:
          attr.id === "PART_NUMBER" || attr.id === "MPN" || attr.id === "OEM"
            ? "Preencha o Part Number da peça antes de publicar."
            : attr.id === "BRAND"
              ? "Preencha a marca do produto antes de publicar."
              : attr.id === "MODEL"
                ? "Preencha o modelo do veículo antes de publicar."
                : `Preencha o campo ${attr.name} antes de publicar.`,
      });
    }

    const ok = missingRequired.length === 0;
    if (!ok || issues.length > 0) {
      console.log(
        JSON.stringify({
          event: "listing.preflight.ml",
          categoryId,
          productId: product.id,
          ok,
          missingRequired,
          issueCodes: issues.map((i) => i.code),
        }),
      );
    }

    return {
      ok,
      issues,
      enrichedAttributes: enriched,
      missingRequired,
    };
  }

  /**
   * Formata issues para mensagem de erro amigável ao usuário.
   */
  static formatBlockMessage(result: MLPreflightResult): string {
    const blocks = result.issues.filter((i) => i.severity === "block");
    if (blocks.length === 0) {
      return "Produto não atende aos requisitos desta categoria no Mercado Livre.";
    }
    if (blocks.length === 1) {
      return blocks[0].fixHint || blocks[0].message;
    }
    const fields = blocks
      .map((b) => b.fixHint || b.message)
      .join(" | ");
    return `Produto precisa de ajustes antes de publicar: ${fields}`;
  }
}
