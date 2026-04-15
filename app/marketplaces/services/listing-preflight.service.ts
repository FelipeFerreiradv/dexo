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
 * Modelos populares → marca. Usado quando o nome do produto cita só o
 * modelo ("Farol Ecosport", "Fechadura Captiva") sem a marca. Ordem importa:
 * multi-word antes de single-word (Grand Siena antes de Siena, Gol G5 antes
 * de Gol, etc.) — o match é feito via word boundary case-insensitive.
 *
 * Por que existe: o dry-run do preflight mostrou ~800 produtos bloqueados
 * por BRAND onde o nome só contém o modelo do veículo. Como o catálogo ML
 * exige BRAND em muitas categorias automotivas, inferir via modelo
 * desbloqueia o fluxo de publicação sem exigir curadoria manual.
 */
const MODEL_TO_BRAND: Array<{ pattern: RegExp; brand: string }> = [
  { pattern: /\bgrand\s*siena\b/i, brand: "Fiat" },
  { pattern: /\bgol\s*g[0-9]\b/i, brand: "Volkswagen" },
  { pattern: /\bfox\b/i, brand: "Volkswagen" },
  { pattern: /\bsaveiro\b/i, brand: "Volkswagen" },
  { pattern: /\bvoyage\b/i, brand: "Volkswagen" },
  { pattern: /\bpolo\b/i, brand: "Volkswagen" },
  { pattern: /\btiguan\b/i, brand: "Volkswagen" },
  { pattern: /\bamarok\b/i, brand: "Volkswagen" },
  { pattern: /\bjetta\b/i, brand: "Volkswagen" },
  { pattern: /\bgol\b/i, brand: "Volkswagen" },
  { pattern: /\bup\b/i, brand: "Volkswagen" },
  { pattern: /\becosport\b/i, brand: "Ford" },
  { pattern: /\bka\b/i, brand: "Ford" },
  { pattern: /\bfiesta\b/i, brand: "Ford" },
  { pattern: /\bfocus\b/i, brand: "Ford" },
  { pattern: /\branger\b/i, brand: "Ford" },
  { pattern: /\bf-?(100|150|250|350|600|1000)\b/i, brand: "Ford" },
  { pattern: /\bfusion\b/i, brand: "Ford" },
  { pattern: /\bedge\b/i, brand: "Ford" },
  { pattern: /\bcourier\b/i, brand: "Ford" },
  { pattern: /\bescort\b/i, brand: "Ford" },
  { pattern: /\bgrand\s*siena\b/i, brand: "Fiat" },
  { pattern: /\bpalio\s*fire\b/i, brand: "Fiat" },
  { pattern: /\bpalio\b/i, brand: "Fiat" },
  { pattern: /\buno\b/i, brand: "Fiat" },
  { pattern: /\bsiena\b/i, brand: "Fiat" },
  { pattern: /\bstrada\b/i, brand: "Fiat" },
  { pattern: /\btoro\b/i, brand: "Fiat" },
  { pattern: /\bargo\b/i, brand: "Fiat" },
  { pattern: /\bcronos\b/i, brand: "Fiat" },
  { pattern: /\bmobi\b/i, brand: "Fiat" },
  { pattern: /\bdoblo\b/i, brand: "Fiat" },
  { pattern: /\bidea\b/i, brand: "Fiat" },
  { pattern: /\bfiorino\b/i, brand: "Fiat" },
  { pattern: /\bducato\b/i, brand: "Fiat" },
  { pattern: /\bpunto\b/i, brand: "Fiat" },
  { pattern: /\blinea\b/i, brand: "Fiat" },
  { pattern: /\btempra\b/i, brand: "Fiat" },
  { pattern: /\bstilo\b/i, brand: "Fiat" },
  { pattern: /\bmarea\b/i, brand: "Fiat" },
  { pattern: /\bbravo\b/i, brand: "Fiat" },
  { pattern: /\bcaptiva\b/i, brand: "Chevrolet" },
  { pattern: /\bonix\b/i, brand: "Chevrolet" },
  { pattern: /\bprisma\b/i, brand: "Chevrolet" },
  { pattern: /\bcobalt\b/i, brand: "Chevrolet" },
  { pattern: /\bcruze\b/i, brand: "Chevrolet" },
  { pattern: /\bspin\b/i, brand: "Chevrolet" },
  { pattern: /\btracker\b/i, brand: "Chevrolet" },
  { pattern: /\bs-?10\b/i, brand: "Chevrolet" },
  { pattern: /\btrailblazer\b/i, brand: "Chevrolet" },
  { pattern: /\bmontana\b/i, brand: "Chevrolet" },
  { pattern: /\bagile\b/i, brand: "Chevrolet" },
  { pattern: /\bcelta\b/i, brand: "Chevrolet" },
  { pattern: /\bcorsa\b/i, brand: "Chevrolet" },
  { pattern: /\bvectra\b/i, brand: "Chevrolet" },
  { pattern: /\bastra\b/i, brand: "Chevrolet" },
  { pattern: /\bzafira\b/i, brand: "Chevrolet" },
  { pattern: /\bomega\b/i, brand: "Chevrolet" },
  { pattern: /\bmeriva\b/i, brand: "Chevrolet" },
  { pattern: /\bblazer\b/i, brand: "Chevrolet" },
  { pattern: /\bkadett\b/i, brand: "Chevrolet" },
  { pattern: /\bipanema\b/i, brand: "Chevrolet" },
  { pattern: /\bmonza\b/i, brand: "Chevrolet" },
  { pattern: /\bcorolla\b/i, brand: "Toyota" },
  { pattern: /\betios\b/i, brand: "Toyota" },
  { pattern: /\bhilux\b/i, brand: "Toyota" },
  { pattern: /\bsw4\b/i, brand: "Toyota" },
  { pattern: /\byaris\b/i, brand: "Toyota" },
  { pattern: /\brav4\b/i, brand: "Toyota" },
  { pattern: /\bcamry\b/i, brand: "Toyota" },
  { pattern: /\bcivic\b/i, brand: "Honda" },
  { pattern: /\bfit\b/i, brand: "Honda" },
  { pattern: /\bcity\b/i, brand: "Honda" },
  { pattern: /\bhr-?v\b/i, brand: "Honda" },
  { pattern: /\bwr-?v\b/i, brand: "Honda" },
  { pattern: /\bcr-?v\b/i, brand: "Honda" },
  { pattern: /\baccord\b/i, brand: "Honda" },
  { pattern: /\bsandero\b/i, brand: "Renault" },
  { pattern: /\blogan\b/i, brand: "Renault" },
  { pattern: /\bduster\b/i, brand: "Renault" },
  { pattern: /\bcaptur\b/i, brand: "Renault" },
  { pattern: /\bkwid\b/i, brand: "Renault" },
  { pattern: /\boroch\b/i, brand: "Renault" },
  { pattern: /\bmaster\b/i, brand: "Renault" },
  { pattern: /\bkangoo\b/i, brand: "Renault" },
  { pattern: /\bmegane\b/i, brand: "Renault" },
  { pattern: /\bscenic\b/i, brand: "Renault" },
  { pattern: /\bfluence\b/i, brand: "Renault" },
  { pattern: /\bclio\b/i, brand: "Renault" },
  { pattern: /\bhb20\b/i, brand: "Hyundai" },
  { pattern: /\bcreta\b/i, brand: "Hyundai" },
  { pattern: /\bix35\b/i, brand: "Hyundai" },
  { pattern: /\btucson\b/i, brand: "Hyundai" },
  { pattern: /\belantra\b/i, brand: "Hyundai" },
  { pattern: /\bi30\b/i, brand: "Hyundai" },
  { pattern: /\bazera\b/i, brand: "Hyundai" },
  { pattern: /\bsonata\b/i, brand: "Hyundai" },
  { pattern: /\bveloster\b/i, brand: "Hyundai" },
  { pattern: /\bvera\s*cruz\b/i, brand: "Hyundai" },
  { pattern: /\bkicks\b/i, brand: "Nissan" },
  { pattern: /\bversa\b/i, brand: "Nissan" },
  { pattern: /\bmarch\b/i, brand: "Nissan" },
  { pattern: /\bsentra\b/i, brand: "Nissan" },
  { pattern: /\bfrontier\b/i, brand: "Nissan" },
  { pattern: /\blivina\b/i, brand: "Nissan" },
  { pattern: /\btiida\b/i, brand: "Nissan" },
  { pattern: /\bc3\b/i, brand: "Citroën" },
  { pattern: /\bc4\b/i, brand: "Citroën" },
  { pattern: /\bxsara\b/i, brand: "Citroën" },
  { pattern: /\bpicasso\b/i, brand: "Citroën" },
  { pattern: /\baircross\b/i, brand: "Citroën" },
  { pattern: /\bjumper\b/i, brand: "Citroën" },
  { pattern: /\bberlingo\b/i, brand: "Citroën" },
  { pattern: /\b208\b/i, brand: "Peugeot" },
  { pattern: /\b2008\b/i, brand: "Peugeot" },
  { pattern: /\b3008\b/i, brand: "Peugeot" },
  { pattern: /\b206\b/i, brand: "Peugeot" },
  { pattern: /\b207\b/i, brand: "Peugeot" },
  { pattern: /\b307\b/i, brand: "Peugeot" },
  { pattern: /\b308\b/i, brand: "Peugeot" },
  { pattern: /\b408\b/i, brand: "Peugeot" },
  { pattern: /\bpartner\b/i, brand: "Peugeot" },
  { pattern: /\bhoggar\b/i, brand: "Peugeot" },
  { pattern: /\btiggo\b/i, brand: "Chery" },
  { pattern: /\bqq\b/i, brand: "Chery" },
  { pattern: /\bs10\b/i, brand: "Chevrolet" },
  { pattern: /\bl200\b/i, brand: "Mitsubishi" },
  { pattern: /\bpajero\b/i, brand: "Mitsubishi" },
  { pattern: /\basx\b/i, brand: "Mitsubishi" },
  { pattern: /\beclipse\b/i, brand: "Mitsubishi" },
  { pattern: /\boutlander\b/i, brand: "Mitsubishi" },
  { pattern: /\blancer\b/i, brand: "Mitsubishi" },
  { pattern: /\brenegade\b/i, brand: "Jeep" },
  { pattern: /\bcompass\b/i, brand: "Jeep" },
  { pattern: /\bgrand\s*cherokee\b/i, brand: "Jeep" },
  { pattern: /\bwrangler\b/i, brand: "Jeep" },
];

/**
 * Extrai marca do nome do produto quando o campo brand está vazio.
 * Tenta primeiro o match direto de marca, depois o mapa MODEL→BRAND
 * para casos "Ecosport", "Captiva", "Palio" etc. sem marca explícita.
 */
function extractBrandFromName(name?: string | null): string | undefined {
  if (!name) return undefined;
  for (const { pattern, canonical } of KNOWN_BRANDS) {
    if (pattern.test(name)) return canonical;
  }
  for (const { pattern, brand } of MODEL_TO_BRAND) {
    if (pattern.test(name)) return brand;
  }
  return undefined;
}

/**
 * Extrai o modelo do veículo a partir do nome do produto usando o mesmo
 * vocabulário do mapa MODEL_TO_BRAND. Retorna o primeiro match.
 */
function extractModelFromName(name?: string | null): string | undefined {
  if (!name) return undefined;
  for (const { pattern } of MODEL_TO_BRAND) {
    const m = name.match(pattern);
    if (m) {
      return m[0].replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) =>
        c.toUpperCase(),
      );
    }
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
  MODEL: (p) => p.model || extractModelFromName(p.name) || undefined,
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
