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
 * Marcas automotivas reconhecidas pelo fallback de extração por nome.
 * Ordem importa — marcas compostas antes das simples (Alfa Romeo antes de Alfa).
 * Match é case-insensitive por word boundary.
 */
const KNOWN_BRANDS: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /\balfa\s*romeo\b/i, canonical: "Alfa Romeo" },
  { pattern: /\bland\s*rover\b/i, canonical: "Land Rover" },
  { pattern: /\bmercedes(\s*benz)?\b/i, canonical: "Mercedes-Benz" },
  { pattern: /\bvolkswagen\b/i, canonical: "Volkswagen" },
  { pattern: /\bchevrolet\b/i, canonical: "Chevrolet" },
  { pattern: /\bmitsubishi\b/i, canonical: "Mitsubishi" },
  { pattern: /\brenault\b/i, canonical: "Renault" },
  { pattern: /\bpeugeot\b/i, canonical: "Peugeot" },
  { pattern: /\bcitro[eë]n\b/i, canonical: "Citroën" },
  { pattern: /\bhyundai\b/i, canonical: "Hyundai" },
  { pattern: /\bnissan\b/i, canonical: "Nissan" },
  { pattern: /\btoyota\b/i, canonical: "Toyota" },
  { pattern: /\bhonda\b/i, canonical: "Honda" },
  { pattern: /\bsuzuki\b/i, canonical: "Suzuki" },
  { pattern: /\bporsche\b/i, canonical: "Porsche" },
  { pattern: /\bferrari\b/i, canonical: "Ferrari" },
  { pattern: /\bchrysler\b/i, canonical: "Chrysler" },
  { pattern: /\bdodge\b/i, canonical: "Dodge" },
  { pattern: /\bsubaru\b/i, canonical: "Subaru" },
  { pattern: /\bvolvo\b/i, canonical: "Volvo" },
  { pattern: /\bchery\b/i, canonical: "Chery" },
  { pattern: /\bjac\b/i, canonical: "JAC" },
  { pattern: /\bgeely\b/i, canonical: "Geely" },
  { pattern: /\bjaguar\b/i, canonical: "Jaguar" },
  { pattern: /\blexus\b/i, canonical: "Lexus" },
  { pattern: /\btroller\b/i, canonical: "Troller" },
  { pattern: /\bfiat\b/i, canonical: "Fiat" },
  { pattern: /\bford\b/i, canonical: "Ford" },
  { pattern: /\baudi\b/i, canonical: "Audi" },
  { pattern: /\bbmw\b/i, canonical: "BMW" },
  { pattern: /\bkia\b/i, canonical: "Kia" },
  { pattern: /\bjeep\b/i, canonical: "Jeep" },
  { pattern: /\bram\b/i, canonical: "RAM" },
  { pattern: /\bmini\b/i, canonical: "MINI" },
  { pattern: /\bgm\b/i, canonical: "Chevrolet" },
  { pattern: /\bvw\b/i, canonical: "Volkswagen" },
];

/**
 * Extrai marca do nome do produto quando o campo brand está vazio.
 * Retorna o canonical match ou undefined se nenhuma marca conhecida aparece.
 */
function extractBrandFromName(name?: string | null): string | undefined {
  if (!name) return undefined;
  for (const { pattern, canonical } of KNOWN_BRANDS) {
    if (pattern.test(name)) return canonical;
  }
  return undefined;
}

/**
 * Extrai um part number plausível do nome do produto.
 * Heurística: token alfanumérico de 6+ caracteres com pelo menos 3 dígitos,
 * ou marcadores explícitos "cod:"/"cód:"/"código:" seguidos de token.
 * Ignora anos (4 dígitos puros) e tokens de dimensão (ex: "16v", "1.6").
 */
function extractPartNumberFromName(name?: string | null): string | undefined {
  if (!name) return undefined;
  const codMatch = name.match(/(?:c[oó]d(?:igo)?\.?\s*:?\s*)([A-Za-z0-9\-]{5,})/i);
  if (codMatch) return codMatch[1];
  const tokens = name.split(/[\s,()/]+/);
  for (const t of tokens) {
    if (t.length < 6) continue;
    if (/^\d{4}$/.test(t)) continue;
    if (/^\d+\.\d+$/.test(t)) continue;
    if (/^\d+v$/i.test(t)) continue;
    const digits = (t.match(/\d/g) || []).length;
    if (digits >= 3 && /^[A-Za-z0-9\-]+$/.test(t)) return t;
  }
  return undefined;
}

/**
 * Mapeamento best-effort de IDs de atributo ML para fields do produto.
 * Usado pelo enrichment para auto-preencher atributos obrigatórios a
 * partir dos campos do domínio, sem exigir mudança no schema do produto.
 * Quando o field direto está vazio, tenta fallback por extração do nome.
 */
const ATTR_TO_FIELD: Record<string, (p: MLPreflightInput["product"]) => string | undefined> = {
  PART_NUMBER: (p) => p.partNumber || extractPartNumberFromName(p.name) || undefined,
  MPN: (p) => p.partNumber || extractPartNumberFromName(p.name) || undefined,
  OEM: (p) => p.partNumber || extractPartNumberFromName(p.name) || undefined,
  GTIN: () => undefined,
  BRAND: (p) => p.brand || extractBrandFromName(p.name) || undefined,
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

/**
 * Para atributos enum (value_type=list) cujos obrigatórios não podem ser
 * derivados do produto, tentamos casar um valor "padrão razoável" dentro
 * da lista `allowedValues` retornada pelo catálogo ML. Para o domínio de
 * autopeças do sistema, valores como VEHICLE_TYPE são quase sempre "Carro".
 *
 * Cada entrada é uma lista de regexes avaliadas em ordem contra os nomes
 * dos allowedValues; o primeiro match vence.
 */
const ENUM_SMART_DEFAULTS: Record<string, RegExp[]> = {
  VEHICLE_TYPE: [
    /^carro/i,
    /^autom[oó]vel/i,
    /caminhonete/i,
    /car$/i,
  ],
  ITEM_CONDITION: [/usad/i, /second/i, /^used$/i],
};

function pickSmartDefault(
  attr: NormalizedMLAttribute,
): { id: string; name: string } | undefined {
  const patterns = ENUM_SMART_DEFAULTS[attr.id];
  if (!patterns || !attr.allowedValues || attr.allowedValues.length === 0) {
    return undefined;
  }
  for (const rx of patterns) {
    const hit = attr.allowedValues.find((v) => rx.test(v.name));
    if (hit) return hit;
  }
  return undefined;
}

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

      const smart = pickSmartDefault(attr);
      if (smart) {
        const newAttr = { id: attr.id, value_name: smart.name };
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
