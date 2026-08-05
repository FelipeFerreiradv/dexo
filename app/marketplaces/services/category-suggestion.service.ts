import { parseTitleToFields } from "@/app/lib/product-parser";
import CategoryRepository from "../repositories/category.repository";
import CategoryAliasRepository from "../repositories/category-alias.repository";
import {
  CategoryInferenceEngine,
  type CategoryInferenceResult,
} from "../lib/category-inference/engine";
import { fuseVotes, shouldAutoApply } from "../lib/category-inference/fuse";
import type { CategoryVote } from "../lib/category-inference/types";
import { getVehicleRootSet } from "./category-resolution.service";
import {
  coherenceVerdict,
  contextCacheSuffix,
  isContextEmpty,
  isV2Enabled,
  shouldAutoApplyV2,
  COHERENCE_PENALTY,
  type CoherenceVerdict,
  type ProductSuggestContext,
} from "../lib/category-suggest-v2";

type AttributeSuggestion = {
  brand?: string;
  model?: string;
  year?: string;
  partNumber?: string;
};

type MeasurementSuggestion = {
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightKg?: number;
};

export type CategorySuggestion = {
  categoryId: string;
  fullPath: string;
  score: number;
  /**
   * "curated"  = mapa tipo-de-peça → categoria (inferência, Sinal A);
   * "internal" = moda da base interna/CatalogStat (inferência, Sinal B).
   * O front tipa como string — ampliar o union é aditivo.
   */
  source: "alias" | "keyword" | "curated" | "internal";
  attributes?: AttributeSuggestion;
  measurements?: MeasurementSuggestion;
  title?: string;
  /** 0–1 confidence derived from score + signal count */
  confidence?: number;
  /** true when confidence >= threshold and can be auto-applied without manual review */
  autoApply?: boolean;
  /** human-readable reasons that contributed to the score */
  reasons?: string[];
  /**
   * Quantos sinais DISTINTOS sustentam esta sugestão (marca, modelo, ano, part
   * number, tokens do alias, mapa curado, base interna...). Campo aditivo: é o
   * que a recalibragem do auto-aplicar consulta, em vez de contar `reasons`.
   */
  signalCount?: number;
  /** inferred piece/part type when identifiable from tokens (e.g. "amortecedor", "porta") */
  pieceType?: string;
};

type AliasEntry = Awaited<
  ReturnType<typeof CategoryAliasRepository.listWithCategory>
>[number];

type CategoryEntry = Awaited<
  ReturnType<typeof CategoryRepository.listWithParents>
>[number];

// Hoisted constants — avoids re-creating on every tokenize() call
const STOPWORDS = new Set([
  "de",
  "da",
  "do",
  "das",
  "dos",
  "para",
  "pra",
  "por",
  "com",
  "sem",
  "na",
  "no",
  "nas",
  "nos",
  "em",
  "uma",
  "um",
  "e",
  "ou",
  "peça",
  "peca",
  "kit",
  "autopecas",
  "autopeças",
]);

const ABBREV: Record<string, string> = {
  vw: "volkswagen",
  gm: "chevrolet",
  chev: "chevrolet",
  mb: "mercedes",
  mbz: "mercedes",
  mercedesbenz: "mercedes",
  vag: "volkswagen",
  // Compound word fragments that survive after stopword/hyphen removal
  choques: "parachoque",
  choque: "parachoque",
  parachoques: "parachoque",
  lamas: "paralama",
  lama: "paralama",
  paralamas: "paralama",
};

// Compound words: normalized forms that should be joined before tokenization.
// Applied on the normalized text (lowercased, no diacritics) before splitting.
const COMPOUND_WORDS: [RegExp, string][] = [
  [/\bpara[\s-]?choques?\b/g, "parachoque"],
  [/\bpara[\s-]?lamas?\b/g, "paralama"],
  [/\bpara[\s-]?brisas?\b/g, "parabrisa"],
  [/\bpara[\s-]?sol\b/g, "parasol"],
  [/\bpara[\s-]?barros?\b/g, "parabarro"],
  [/\blimpa[\s-]?vidros?\b/g, "limpavidro"],
  [/\bponta[\s-]?eixo\b/g, "pontaeixo"],
  [/\bcaixa[\s-]?direcao\b/g, "caixadirecao"],
  [/\bbomba[\s-]?dagua\b/g, "bombadagua"],
];

// ── Domain detection: automotive signals & incompatible domain tokens ──
const AUTOMOTIVE_SIGNALS = new Set([
  // Peças de carroceria / lataria
  "grade",
  "parachoque",
  "paralama",
  "retrovisor",
  "capô",
  "capo",
  "porta",
  "vidro",
  "parabrisa",
  "lanterna",
  "farol",
  "macaneta",
  "lataria",
  "carroceria",
  "spoiler",
  "defletor",
  "friso",
  // Suspensão / direção
  "amortecedor",
  "mola",
  "bandeja",
  "pivo",
  "bieleta",
  "batente",
  "coifa",
  "bucha",
  "cubo",
  "rolamento",
  "terminal",
  "caixa direcao",
  // Motor / transmissão
  "motor",
  "biela",
  "pistao",
  "virabrequim",
  "cabecote",
  "bloco",
  "comando",
  "valvula",
  "junta",
  "carter",
  "coletor",
  "turbo",
  "embreagem",
  "transmissao",
  "diferencial",
  "semieixo",
  // Freio
  "freio",
  "disco",
  "pastilha",
  "pinca",
  "cilindro",
  "tambor",
  "flexivel",
  "lonas",
  // Elétrica
  "alternador",
  "motor arranque",
  "bobina",
  "sensor",
  "modulo",
  "vela",
  "chicote",
  "rele",
  // Arrefecimento / escapamento
  "radiador",
  "ventoinha",
  "mangueira",
  "valvula termostatica",
  "escapamento",
  "catalisador",
  "silencioso",
  // Filtros / fluidos
  "filtro",
  "oleo",
  // Correia / tensor
  "correia",
  "tensor",
  "bomba",
  // Posicionais (fortes indicadores automotivos quando combinados)
  "traseira",
  "traseiro",
  "dianteira",
  "dianteiro",
  "lateral",
  // Marcas automotivas (normalizadas)
  "chevrolet",
  "volkswagen",
  "ford",
  "fiat",
  "renault",
  "hyundai",
  "honda",
  "toyota",
  "nissan",
  "mitsubishi",
  "peugeot",
  "citroen",
  "kia",
  "suzuki",
  "bmw",
  "mercedes",
  // Modelos populares
  "onix",
  "gol",
  "civic",
  "corolla",
  "hb20",
  "creta",
  "kicks",
  "compass",
  "renegade",
  "tracker",
  "t-cross",
  "polo",
  "virtus",
  "argo",
  "mobi",
  "toro",
  "hilux",
  "s10",
  "ranger",
  "amarok",
  "palio",
  "uno",
  "siena",
  "punto",
  "idea",
  "stilo",
  "strada",
  "linea",
  "bravo",
  "celta",
  "corsa",
  "astra",
  "vectra",
  "meriva",
  "agile",
  "prisma",
  "cruze",
  "spin",
  "cobalt",
  "montana",
  "fiesta",
  "ecosport",
  "focus",
  "ka",
  "edge",
  "fusion",
  "saveiro",
  "fox",
  "crossfox",
  "spacefox",
  "voyage",
  "parati",
  "golf",
  "jetta",
  "passat",
  "tiguan",
  "up",
  "nivus",
  "taos",
  "logan",
  "sandero",
  "duster",
  "stepway",
  "kwid",
  "captur",
  "oroch",
  "clio",
  "megane",
  "scenic",
  "tucson",
  "ix35",
  "santa fe",
  "i30",
  "azera",
  "elantra",
  "veloster",
  "accent",
  "hr-v",
  "hrv",
  "fit",
  "city",
  "wr-v",
  "wrv",
  "yaris",
  "etios",
  "rav4",
  "sw4",
  "tiida",
  "march",
  "versa",
  "sentra",
  "livina",
  "frontier",
  "pajero",
  "asx",
  "outlander",
  "l200",
  "lancer",
  "208",
  "2008",
  "3008",
  "308",
  "408",
  "partner",
  "c3",
  "c4",
  "cactus",
  "aircross",
  "picanto",
  "cerato",
  "sportage",
  "sorento",
  "soul",
  "jimny",
  "vitara",
  "gran vitara",
  // Tipos de peças/acessórios comuns em anúncios
  "teto",
  "tejadilho",
  "painel",
  "banco",
  "assento",
  "encosto",
  "cinto seguranca",
  "cinto",
  "volante",
  "acabamento",
  "moldura",
  "luz",
  "luzes",
  "lampada",
  "lampadas",
  "iluminacao",
  "interna",
  "airbag",
  "console",
  "porta-luvas",
  "tapete",
  "protetor",
  "soleira",
  "maquina vidro",
  "macaneta",
  "puxador",
  "emblema",
  "logo",
  "calota",
  "roda",
  "pneu",
  "bagageiro",
  "rack",
  "engate",
  "teto solar",
]);

// Tokens que, quando encontrados no fullPath de uma categoria, indicam
// domínio incompatível com automotivo.
// Pre-computed as a frozen array to avoid Set→Array conversion on every call.
const INCOMPATIBLE_WITH_AUTOMOTIVE: readonly string[] = Object.freeze([
  // Beleza / estética
  "beleza",
  "beauty",
  "maquiagem",
  "cosmetico",
  "cabelo",
  "unha",
  "perfume",
  "skincare",
  "capilar",
  "manicure",
  "estetica",
  "shampoo",
  "condicionador",
  "creme",
  "hidratante",
  // Esporte / lazer
  "esporte",
  "sport",
  "frisbee",
  "raquete",
  "bola",
  "tenis",
  "futebol",
  "basquete",
  "natacao",
  "yoga",
  "fitness",
  "academia",
  "camping",
  "pesca",
  "hobbies e colecoes",
  // Brinquedos / jogos
  "brinquedo",
  "toy",
  "boneca",
  "jogos",
  "quebra-cabeca",
  "lego",
  "pelucia",
  // Moda / vestuário
  "moda",
  "roupa",
  "vestuario",
  "calcado",
  "sapato",
  "bolsa",
  "cinto",
  "relogio",
  "oculos",
  "joias",
  "bijuteria",
  "chapeu",
  "bone",
  "acessorios para moda",
  "acessorio de moda",
  // Eletrônicos (não automotivos)
  "smartphone",
  "tablet",
  "notebook",
  "fone",
  "caixa de som",
  "videogame",
  "console",
  // Casa / cozinha
  "panela",
  "prato",
  "talher",
  "copo",
  "jarra",
  "fogao",
  "geladeira",
  "microondas",
  "liquidificador",
  // Pet
  "pet",
  "racao",
  "coleira",
  "aquario",
  // Alimentos
  "alimento",
  "bebida",
  "cafe",
  "chocolate",
  "biscoito",
  // Papelaria / escritório
  "papelaria",
  "caderno",
  "caneta",
  "mochila escolar",
  // Bebê
  "bebe",
  "fralda",
  "mamadeira",
  "carrinho bebe",
  // Saúde
  "medicamento",
  "vitamina",
  "suplemento",
]);

// Regex compiled once
const DIACRITICS_RE = /[\u0300-\u036f]/g;
const NON_ALNUM_RE = /[^a-z0-9\s]/g;
const WHITESPACE_RE = /\s+/;

export class CategorySuggestionService {
  private static aliasCacheMap = new Map<
    string,
    { loadedAt: number; items: AliasEntry[] }
  >();
  private static categoryCacheMap = new Map<
    string,
    { loadedAt: number; items: CategoryEntry[] }
  >();
  private static parentMapCache = new Map<
    string,
    {
      byExternal: Map<string, CategoryEntry>;
      byParent: Map<string, CategoryEntry[]>;
    }
  >();
  /** Per-siteId token → category-count map for IDF weighting */
  private static tokenFreqCache = new Map<
    string,
    { totalCats: number; freq: Map<string, number> }
  >();
  /** Per-siteId cached tokenized + normalized category paths */
  private static catTokenCache = new Map<
    string,
    Map<string, { tokens: string[]; normalized: string }>
  >();
  /** Cached parsed alias tokens (aliasId → { aliasTokens, synonymTokens }) */
  private static aliasTokenCache = new Map<
    string,
    { aliasTokens: string[]; synonymTokens: string[] }
  >();
  private static readonly CACHE_MS = 5 * 60 * 1000;

  /** Per-title cached suggestion result (siteId + normalizedTitle → result, TTL 1h) */
  private static suggestResultCache = new Map<
    string,
    {
      cachedAt: number;
      result: {
        normalizedTitle: string;
        tokens: string[];
        suggestions: CategorySuggestion[];
      };
    }
  >();
  private static readonly SUGGEST_CACHE_TTL_MS = 60 * 60 * 1000;
  private static readonly SUGGEST_CACHE_MAX_ENTRIES = 2000;

  private static normalize(text?: string): string {
    return (text || "")
      .toString()
      .normalize("NFD")
      .replace(DIACRITICS_RE, "")
      .toLowerCase()
      .trim();
  }

  /**
   * Tokenizes text that has already been normalized + compound-replaced.
   * Avoids redundant normalize/compound passes when caller already did that work.
   */
  private static tokenizeFromNormalized(normalized: string): string[] {
    const parts = normalized.replace(NON_ALNUM_RE, " ").split(WHITESPACE_RE);
    const result: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i];
      if (!raw) continue;
      const t = ABBREV[raw] || raw;
      if (!STOPWORDS.has(t)) result.push(t);
    }
    return result;
  }

  private static tokenize(text: string): string[] {
    let cleaned = this.normalize(text);
    for (let i = 0; i < COMPOUND_WORDS.length; i++) {
      cleaned = cleaned.replace(COMPOUND_WORDS[i][0], COMPOUND_WORDS[i][1]);
    }
    return this.tokenizeFromNormalized(cleaned);
  }

  private static parseTokens(str?: string | null): string[] {
    if (!str) return [];
    const parts = str.split(/[,\s]+/);
    const result: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const t = this.normalize(parts[i]);
      if (t) result.push(t);
    }
    return result;
  }

  private static async loadAliases(siteId: string) {
    const cached = this.aliasCacheMap.get(siteId);
    if (cached && Date.now() - cached.loadedAt < this.CACHE_MS) {
      return cached.items;
    }
    const items = await CategoryAliasRepository.listWithCategory(siteId);
    this.aliasCacheMap.set(siteId, { loadedAt: Date.now(), items });
    this.aliasTokenCache.clear(); // Invalidate parsed alias tokens
    return items;
  }

  private static async loadCategories(siteId: string) {
    const cached = this.categoryCacheMap.get(siteId);
    if (cached && Date.now() - cached.loadedAt < this.CACHE_MS) {
      return cached.items;
    }
    const items = await CategoryRepository.listWithParents(siteId);
    this.categoryCacheMap.set(siteId, { loadedAt: Date.now(), items });
    // Invalidate dependent caches when categories reload
    this.parentMapCache.delete(siteId);
    this.tokenFreqCache.delete(siteId);
    this.catTokenCache.delete(siteId);
    // Drop per-siteId suggestion cache entries (keys are "siteId::title")
    const prefix = `${siteId}::`;
    for (const key of this.suggestResultCache.keys()) {
      if (key.startsWith(prefix)) this.suggestResultCache.delete(key);
    }
    return items;
  }

  // ── Domain detection ──

  /**
   * Detects the product domain from its title tokens.
   * Returns "automotive" when at least 1 strong automotive signal is present.
   */
  private static detectDomain(tokens: string[]): string | null {
    // 1 hit is enough — automotive vocabulary is very specific
    for (let i = 0; i < tokens.length; i++) {
      if (AUTOMOTIVE_SIGNALS.has(tokens[i])) return "automotive";
    }
    return null;
  }

  /**
   * Returns true when the category fullPath contains tokens from a domain
   * that is incompatible with the detected product domain.
   * Accepts pre-normalized path to avoid redundant normalize() calls.
   */
  private static isDomainIncompatible(
    domain: string | null,
    categoryPath: string,
    preNormalized = false,
  ): boolean {
    if (domain !== "automotive") return false;
    const pathNorm = preNormalized
      ? categoryPath
      : this.normalize(categoryPath);
    for (let i = 0; i < INCOMPATIBLE_WITH_AUTOMOTIVE.length; i++) {
      if (pathNorm.includes(INCOMPATIBLE_WITH_AUTOMOTIVE[i])) return true;
    }
    return false;
  }

  // ── Token frequency (IDF) ──

  private static buildTokenFrequency(
    siteId: string,
    categories: CategoryEntry[],
  ) {
    const freq = new Map<string, number>();
    for (let c = 0; c < categories.length; c++) {
      const cat = categories[c];
      const catPath = cat.fullPath || cat.name || "";
      // Reuse getCatTokenized to avoid duplicate tokenization work
      const { tokens: tokenArr } = this.getCatTokenized(
        siteId,
        cat.externalId,
        catPath,
      );
      const seen = new Set<string>();
      for (let i = 0; i < tokenArr.length; i++) {
        if (!seen.has(tokenArr[i])) {
          seen.add(tokenArr[i]);
          freq.set(tokenArr[i], (freq.get(tokenArr[i]) || 0) + 1);
        }
      }
    }
    const entry = { totalCats: categories.length, freq };
    this.tokenFreqCache.set(siteId, entry);
    return entry;
  }

  private static getTokenFrequency(
    siteId: string,
    categories: CategoryEntry[],
  ) {
    return (
      this.tokenFreqCache.get(siteId) ||
      this.buildTokenFrequency(siteId, categories)
    );
  }

  /** Returns cached { tokens, normalized } for a category path to avoid re-tokenizing */
  private static getCatTokenized(
    siteId: string,
    catExternalId: string,
    catPath: string,
  ): { tokens: string[]; normalized: string } {
    let siteCache = this.catTokenCache.get(siteId);
    if (!siteCache) {
      siteCache = new Map();
      this.catTokenCache.set(siteId, siteCache);
    }
    let cached = siteCache.get(catExternalId);
    if (!cached) {
      let norm = this.normalize(catPath);
      for (let i = 0; i < COMPOUND_WORDS.length; i++) {
        norm = norm.replace(COMPOUND_WORDS[i][0], COMPOUND_WORDS[i][1]);
      }
      cached = {
        tokens: this.tokenizeFromNormalized(norm),
        normalized: norm,
      };
      siteCache.set(catExternalId, cached);
    }
    return cached;
  }

  /** Returns cached parsed alias tokens */
  private static getParsedAliasTokens(alias: AliasEntry): {
    aliasTokens: string[];
    synonymTokens: string[];
  } {
    let cached = this.aliasTokenCache.get(alias.id);
    if (!cached) {
      cached = {
        aliasTokens: this.parseTokens(alias.tokens),
        synonymTokens: this.parseTokens(alias.synonyms),
      };
      this.aliasTokenCache.set(alias.id, cached);
    }
    return cached;
  }

  private static buildParentMaps(categories: CategoryEntry[]) {
    const byExternal = new Map<string, CategoryEntry>();
    const byParent = new Map<string, CategoryEntry[]>();

    for (const c of categories) {
      byExternal.set(c.externalId, c);
      if (c.parentExternalId) {
        const list = byParent.get(c.parentExternalId) || [];
        list.push(c);
        byParent.set(c.parentExternalId, list);
      }
    }

    return { byExternal, byParent };
  }

  private static ensureLeafLocal(
    externalId: string,
    categories: CategoryEntry[],
    prebuiltMaps?: {
      byExternal: Map<string, CategoryEntry>;
      byParent: Map<string, CategoryEntry[]>;
    },
  ): CategoryEntry | null {
    const { byExternal, byParent } =
      prebuiltMaps || this.buildParentMaps(categories);
    let current: CategoryEntry | undefined = byExternal.get(externalId);
    if (!current) return null;

    while (byParent.has(current.externalId)) {
      const children: CategoryEntry[] = byParent.get(current.externalId)!;
      if (!children.length) break;
      let next: CategoryEntry = children[0];
      for (let i = 0; i < children.length; i++) {
        const path = children[i].fullPath || children[i].name;
        // Lowercase-only check avoids full normalize (NFD + regex) per child
        if (path && path.toLowerCase().includes("outros")) {
          next = children[i];
          break;
        }
      }
      current = next;
    }
    return current ?? null;
  }

  private static buildTitleSuggestion(
    attrs: AttributeSuggestion,
    tokens: string[],
    originalTitle: string,
  ): string | undefined {
    const pieceTokens = tokens.filter(
      (t) =>
        t !== this.normalize(attrs.brand) &&
        t !== this.normalize(attrs.model) &&
        t !== this.normalize(attrs.year) &&
        t !== this.normalize(attrs.partNumber),
    );
    const piece =
      pieceTokens.length > 0
        ? pieceTokens.map((t) => t[0]?.toUpperCase() + t.slice(1)).join(" ")
        : originalTitle;

    const parts = [
      attrs.brand,
      attrs.model,
      piece,
      attrs.year,
      attrs.partNumber ? `| ${attrs.partNumber}` : undefined,
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    return parts || undefined;
  }

  private static scoreAliasMatch(opts: {
    tokenSet: Set<string>;
    tokens: string[];
    aliasTokens: string[];
    synonymTokens: string[];
    patterns: any;
    rawText: string;
    /**
     * Fatos AFIRMADOS pelo formulário (não adivinhados do título). Entram como
     * casamento estruturado — nunca como token no saco de tokens: a régua
     * mostrou que despejar o contexto na tokenização derruba a Shopee de 73,3%
     * para 41,5%, porque lá o único caminho é o keyword sobre o `fullPath` e o
     * `matchRatio` (hits / total de tokens) fica diluído.
     */
    ctxBrand?: string | null;
    ctxModel?: string | null;
    ctxYear?: string | null;
  }) {
    const {
      tokenSet,
      tokens,
      aliasTokens,
      synonymTokens,
      patterns,
      rawText,
      ctxBrand,
      ctxModel,
      ctxYear,
    } = opts;
    const norm = (s: string) => this.normalize(s);
    const ctxHas = (fact: string | null | undefined, value: string) => {
      if (!fact) return false;
      return norm(fact) === norm(value);
    };
    const intersect = aliasTokens.filter((t) => tokenSet.has(t));
    const synonymHits = synonymTokens.filter((t) => tokenSet.has(t));
    const reasons: string[] = [];

    /**
     * A coluna `CategoryAlias.tokens` foi populada com o TÍTULO INTEIRO do
     * anúncio de origem, veículo incluído. Exemplo real:
     *
     *   tokens="acabamento,retrovisor,direito,volvo,v40,2014,1287712,pecas,..."
     *
     * Consequência: "volkswagen", "fox", "2011" e "2012" entravam em
     * `intersect` e valiam +2 cada (8 pontos), e AINDA somavam +3 de marca e
     * +2 de modelo pelo `brandModelPatterns` — o mesmo veículo contado duas
     * vezes, sem que o tipo de peça precisasse casar uma única vez.
     *
     * Medido em produção com "Retrovisor Direito Volkswagen fox 2011 2012":
     * cinco categorias empatavam em score 13 — Fechaduras de Portas, Grades de
     * Faróis de Milha, Reservatório do Radiador, Carroceria > Outros — todas
     * com confiança 0,95 e TODAS auto-aplicadas. Nenhuma tinha relação com
     * retrovisor. O mesmo título sem marca/modelo/ano acertava a categoria.
     *
     * Aqui os tokens de veículo e os puramente numéricos (ano, part number)
     * deixam de contar como evidência de TIPO DE PEÇA. Eles continuam
     * pontuando pelo caminho próprio (marca/modelo/ano), que é onde têm peso
     * calibrado e não duplicam.
     */
    const vehicleTokens = new Set<string>();
    if (patterns?.brand) vehicleTokens.add(norm(patterns.brand));
    if (patterns?.model) vehicleTokens.add(norm(patterns.model));
    if (patterns?.years) {
      const ys = Array.isArray(patterns.years)
        ? patterns.years
        : [patterns.years];
      for (const y of ys) vehicleTokens.add(norm(String(y)));
    }
    const gateOn = isV2Enabled();
    const pieceHits = gateOn
      ? intersect.filter((t) => !vehicleTokens.has(t) && !/^\d+$/.test(t))
      : intersect;

    let score = pieceHits.length * 2 + synonymHits.length;
    let signalCount = 0;

    if (pieceHits.length > 0) {
      reasons.push(`tokens diretos: ${pieceHits.join(", ")}`);
      signalCount++;
    }
    if (synonymHits.length > 0) {
      reasons.push(`sinônimos: ${synonymHits.join(", ")}`);
      signalCount++;
    }

    const attr: AttributeSuggestion = {};

    /**
     * ORDEM DE PRIORIDADE DOS SINAIS (explícita, V2):
     *   1. tipo de peça  — é o que IDENTIFICA a categoria;
     *   2. marca / modelo / ano — QUALIFICAM a peça, não a identificam;
     *   3. texto livre.
     *
     * Antes, (2) somava sozinho: um alias de "fechadura VW Fox 2011" ganhava
     * 3+2+1 = 6 pontos em QUALQUER produto de um VW Fox 2011, sem casar um
     * único token do tipo de peça — e 6 pontos batem os 2 de um token de tipo
     * correto. Foi isto que a régua flagrou em produção:
     *
     *   "Retrovisor Eletrico Gol G5"                    -> Espelhos Retrovisores Laterais  (certo)
     *   "Retrovisor Direito Volkswagen fox 2011 2012"   -> Fechaduras de Portas   conf 0,95 AUTO-APLICADO
     *   "Retrovisor Esquerdo Chevrolet Onix Prisma ..." -> Portas                 conf 1,00 AUTO-APLICADO
     *   "Retrovisor Manual Direito Fiat Palio Siena ..." -> Climatização > Comandos conf 1,00 AUTO-APLICADO
     *
     * O mesmo título, sem marca/modelo/ano, acertava. Quanto MAIS contexto o
     * usuário dava, PIOR ficava a sugestão — e com confiança alta o bastante
     * para auto-aplicar.
     *
     * Com o gate: marca/modelo/ano só pontuam quando o alias já demonstrou
     * evidência do tipo de peça (token direto ou sinônimo). Eles continuam
     * desempatando entre aliases do mesmo tipo, que é o papel deles.
     */
    // Com o V2 ligado, os qualificadores de veículo só pontuam quando o alias
    // já demonstrou evidência do tipo de peça. Com o kill-switch, voltam a
    // somar sempre — byte-idêntico ao comportamento anterior.
    const vehicleFactsScore =
      !gateOn || pieceHits.length > 0 || synonymHits.length > 0;

    if (patterns?.brand) {
      const brandNorm = norm(patterns.brand);
      if (
        vehicleFactsScore &&
        (tokenSet.has(brandNorm) || ctxHas(ctxBrand, patterns.brand))
      ) {
        score += 3;
        reasons.push(`marca: ${patterns.brand}`);
        signalCount++;
      }
      attr.brand = patterns.brand;
    }

    if (patterns?.model) {
      const modelNorm = norm(patterns.model);
      if (
        vehicleFactsScore &&
        (tokenSet.has(modelNorm) || ctxHas(ctxModel, patterns.model))
      ) {
        score += 2;
        reasons.push(`modelo: ${patterns.model}`);
        signalCount++;
      }
      attr.model = patterns.model;
    }

    if (patterns?.years) {
      const years: string[] = Array.isArray(patterns.years)
        ? patterns.years
        : [patterns.years];
      const yearHit = years.find(
        (y) => tokenSet.has(norm(y)) || ctxHas(ctxYear, y),
      );
      if (vehicleFactsScore && yearHit) {
        score += 1;
        attr.year = yearHit;
        reasons.push(`ano: ${yearHit}`);
        signalCount++;
      }
    }

    if (patterns?.partNumber) {
      const pnNorm = norm(patterns.partNumber);
      if (pnNorm && rawText.includes(pnNorm)) {
        score += 3;
        attr.partNumber = patterns.partNumber;
        reasons.push(`part number: ${patterns.partNumber}`);
        signalCount++;
      }
    }

    // Detect piece type from the alias tokens that matched
    const pieceType = pieceHits.length > 0 ? pieceHits[0] : undefined;

    const measurements: MeasurementSuggestion | undefined =
      patterns?.measurements;

    return { score, attr, measurements, reasons, signalCount, pieceType };
  }

  /**
   * Entrada historica: só o título. Continua existindo com a MESMA assinatura e
   * o mesmo retorno — delega para `suggestFromProduct` com o contexto vazio, o
   * que é transparente por construção (contexto vazio => mesma chave de cache,
   * mesmo enriquecimento, mesmo ranking).
   */
  static async suggestFromTitle(
    title: string,
    siteId = "MLB",
  ): Promise<{
    normalizedTitle: string;
    tokens: string[];
    suggestions: CategorySuggestion[];
  }> {
    return this.suggestFromProduct({ title }, siteId);
  }

  /**
   * Último segmento do `fullPath` — o nome da própria folha. A coerência olha
   * SÓ a folha: o caminho inteiro carrega qualificadores dos ancestrais
   * ("Peças de Interior") que não qualificam a categoria final.
   */
  private static leafNameOf(fullPath?: string): string {
    if (!fullPath) return "";
    const parts = fullPath.split(">");
    return (parts[parts.length - 1] || "").trim();
  }

  /** Quantos sinais distintos sustentam a sugestão (1 quando não informado). */
  private static signalCountOf(s: CategorySuggestion): number {
    if (typeof s.signalCount === "number") return s.signalCount;
    return s.source === "keyword" ? 1 : 2;
  }

  /**
   * Entrada rica: o formulário manda o que já tem em mãos (marca, modelo, ano,
   * versão, part number, categoria interna, veículo de origem, medidas...) em
   * vez de só o título.
   *
   * Até 04/08/2026 as nove chamadas do front mandavam apenas o título e
   * jogavam fora todo o resto — inclusive campos que eram LIDOS no mesmo
   * callback (create-product-dialog.tsx:2295-2299). Era o maior ganho parado
   * em cima da mesa.
   *
   * Aditivo: contexto ausente => comportamento e chave de cache idênticos aos
   * de quem chama por título.
   */
  static async suggestFromProduct(
    input: ProductSuggestContext,
    siteId = "MLB",
  ): Promise<{
    normalizedTitle: string;
    tokens: string[];
    suggestions: CategorySuggestion[];
  }> {
    const title = input.title;
    const v2 = isV2Enabled();
    const hasContext = v2 && !isContextEmpty(input);
    const startedAt = Date.now();
    const normalizedTitle = this.normalize(title);
    const baseTokens = this.tokenize(title);
    // O contexto NÃO entra no saco de tokens. Medido em 04/08/2026: despejar
    // marca/modelo/versão/categoria interna na tokenização derruba a Shopee de
    // 73,3% para 41,5% de top-1, porque lá o único caminho é o keyword sobre o
    // `fullPath` e a confiança usa `matchRatio = hits / total de tokens` — cada
    // token de contexto que não casa com nada dilui o denominador. O contexto
    // entra como FATO ESTRUTURADO em `scoreAliasMatch` (marca/modelo/ano) e em
    // `aliasRawText` (part number), onde ele soma sem diluir.
    const tokens = baseTokens;

    // ── Result cache (siteId + normalizedTitle) ──
    // suggestFromTitle is pure relative to its caches (aliases/categories are
    // invalidated via loadCategories/loadAliases when data changes), so the
    // same title produces the same result until those caches flip. The log
    // "suggestFromTitle lento: 3728ms" showed repeated calls for similar
    // titles during modal interactions — caching here avoids recomputing.
    // Sem contexto o sufixo é string vazia, então a chave continua sendo
    // exatamente `${siteId}::${normalizedTitle}` — as entradas antigas seguem
    // válidas. Com contexto, a chave passa a distingui-lo; sem isso o primeiro
    // resultado "grudaria" por 1h e o enriquecimento não teria efeito nenhum.
    const cacheKey = `${siteId}::${normalizedTitle}${hasContext ? contextCacheSuffix(input) : ""}`;
    const cached = this.suggestResultCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.SUGGEST_CACHE_TTL_MS) {
      return cached.result;
    }

    // ── Inferência por tipo de peça (Sinal A: mapa curado; B: base interna) ──
    // Fail-open por construção: qualquer erro → sem votos → comportamento
    // atual intacto. Kill-switch de emergência: CATEGORY_INFERENCE_DISABLED=1
    // (o cache de resultado de 1h atrasa o flip; emergência pede restart).
    let inference: CategoryInferenceResult = { votes: [], pieceType: null };
    if (process.env.CATEGORY_INFERENCE_DISABLED !== "1") {
      try {
        inference = await CategoryInferenceEngine.collectVotes(siteId, title);
      } catch {
        // O engine já é fail-open por dentro; este catch é cinto-e-suspensório
        // para o endpoint nunca cair por causa da inferência.
      }
    }

    // ── Guard: titles too short for keyword-only matching (SHP has no aliases) ──
    // Com voto de inferência ("Farol" tem 1 token mas tipo conhecido) o fluxo
    // segue; sem voto, retorna vazio exatamente como antes.
    if (tokens.length < 2 && siteId !== "MLB" && inference.votes.length === 0) {
      return { normalizedTitle, tokens, suggestions: [] };
    }

    const aliasEntries = await this.loadAliases(siteId);
    const categories = await this.loadCategories(siteId);
    // Use cached parent maps (rebuilt only when categories change)
    let parentMaps = this.parentMapCache.get(siteId);
    if (!parentMaps) {
      parentMaps = this.buildParentMaps(categories);
      this.parentMapCache.set(siteId, parentMaps);
    }
    const parsed = parseTitleToFields(title);
    // O que o usuário digitou no formulário tem precedência sobre o que a
    // heurística adivinha do título — é dado afirmado, não inferido.
    const baseAttr: AttributeSuggestion = hasContext
      ? {
          brand: input.brand?.trim() || parsed.brand,
          model: input.model?.trim() || parsed.model,
          year: input.year?.trim() || parsed.year,
          partNumber: input.partNumber?.trim() || undefined,
        }
      : { brand: parsed.brand, model: parsed.model, year: parsed.year };
    // `rawText` é onde o casamento de part number procura (substring, não
    // token). Com contexto, o PN do formulário entra aqui mesmo que o título
    // não o contenha — é o sinal mais forte que existe e estava sendo perdido.
    const aliasRawText = hasContext
      ? [normalizedTitle, this.normalize(input.partNumber ?? undefined)]
          .filter(Boolean)
          .join(" ")
      : normalizedTitle;
    const suggestions = new Map<string, CategorySuggestion>();

    // Build token Set once for the entire alias loop (O(1) lookup vs O(n) array scan)
    const tokenSet = new Set(tokens);

    // Detect product domain for cross-domain blocking
    const detectedDomain = this.detectDomain(tokens);

    for (const alias of aliasEntries) {
      const { aliasTokens, synonymTokens } = this.getParsedAliasTokens(alias);
      let patterns: any = null;
      if (alias.brandModelPatterns) {
        try {
          patterns = JSON.parse(alias.brandModelPatterns);
        } catch {}
      }

      const { score, attr, measurements, reasons, signalCount, pieceType } =
        this.scoreAliasMatch({
          tokenSet,
          tokens,
          aliasTokens,
          synonymTokens,
          patterns,
          rawText: aliasRawText,
          ctxBrand: hasContext ? input.brand : null,
          ctxModel: hasContext ? input.model : null,
          ctxYear: hasContext ? input.year : null,
        });

      if (!alias.marketplaceCategory?.externalId || score <= 0) continue;

      // Block cross-domain matches (e.g., automotive product → beauty category)
      if (detectedDomain === "automotive") {
        const catPath =
          alias.marketplaceCategory.fullPath ||
          alias.marketplaceCategory.name ||
          "";
        const catPathNorm = this.normalize(catPath);
        if (this.isDomainIncompatible(detectedDomain, catPathNorm, true))
          continue;
      }

      const leaf = this.ensureLeafLocal(
        alias.marketplaceCategory.externalId,
        categories,
        parentMaps,
      );
      if (!leaf?.externalId) continue;

      // Also check the resolved leaf path for domain incompatibility
      if (detectedDomain === "automotive") {
        const leafPathNorm = this.normalize(leaf.fullPath || leaf.name);
        if (this.isDomainIncompatible(detectedDomain, leafPathNorm, true))
          continue;
      }

      const mergedAttr: AttributeSuggestion = {
        ...baseAttr,
        ...attr,
        year: attr.year || baseAttr.year,
      };

      const titleSuggestion = this.buildTitleSuggestion(
        mergedAttr,
        tokens,
        title,
      );

      // Confidence: normalize score to 0–1 range based on signal count and absolute score.
      // High confidence requires multiple converging signals (brand + piece + keyword, etc.)
      const confidence = Math.min(
        1,
        (score / 12) * 0.6 + (Math.min(signalCount, 4) / 4) * 0.4,
      );
      const AUTO_APPLY_THRESHOLD = 0.65;
      const autoApply = confidence >= AUTO_APPLY_THRESHOLD && signalCount >= 2;

      const existing = suggestions.get(leaf.externalId);
      if (!existing || existing.score < score) {
        suggestions.set(leaf.externalId, {
          categoryId: leaf.externalId,
          fullPath: leaf.fullPath || leaf.name,
          score,
          source: "alias",
          attributes: mergedAttr,
          measurements,
          title: titleSuggestion,
          confidence,
          autoApply,
          reasons,
          pieceType,
          signalCount,
        });
      }
    }

    // Fallback: keywords on category fullPath (low confidence — single signal)
    // Uses IDF weighting and bigram boost to avoid single-token junk matches.
    if (suggestions.size === 0) {
      const { totalCats, freq: tokenFreq } = this.getTokenFrequency(
        siteId,
        categories,
      );
      const HIGH_FREQ_THRESHOLD = 0.15; // token in >15% of categories → low weight

      // Pre-compute bigrams from the title for contiguous-match boost
      const titleBigrams =
        tokens.length >= 2
          ? tokens.slice(0, -1).map((t, i) => `${t} ${tokens[i + 1]}`)
          : [];

      const invTotalCats = 1 / Math.max(totalCats, 1);

      // Domain-aware boost for non-MLB marketplaces.
      // Shopee has no aliases, so categories are matched by keyword only.
      // Product titles are very specific ("Guia Parachoque Traseiro Ford Fusion 2014")
      // while Shopee categories use "Peças e Acessórios para Veículos > ... > Para-choques".
      // When we detect the product domain (e.g., automotive), categories in that same
      // domain tree get an implicit +1 hit, bridging the vocabulary gap.
      // Multiple path markers needed: Shopee uses "veiculos", "automoveis", "automotiv*"
      const domainPathMarkers: readonly string[] | null =
        detectedDomain === "automotive" && siteId !== "MLB"
          ? ["veiculos", "automoveis", "automotiv"]
          : null;

      for (const cat of categories) {
        const catPath = cat.fullPath || cat.name || "";
        const { tokens: catTokens, normalized: catPathNorm } =
          this.getCatTokenized(siteId, cat.externalId, catPath);

        // Block cross-domain matches (path already normalized)
        if (this.isDomainIncompatible(detectedDomain, catPathNorm, true))
          continue;

        // Domain hard filter for non-MLB: when an automotive product is detected,
        // only categories within the automotive tree are eligible. Prevents
        // cross-domain matches via incidental token overlap (e.g. "Bolsa Airbag"
        // matching fashion "Bolsas" category).
        let domainBoost = 0;
        if (domainPathMarkers) {
          let inDomain = false;
          for (let m = 0; m < domainPathMarkers.length; m++) {
            if (catPathNorm.includes(domainPathMarkers[m])) {
              inDomain = true;
              break;
            }
          }
          if (!inDomain) continue;
          domainBoost = 1;
        }

        // Fast count — bail early if < 2 hits (including domain boost)
        let hitCount = domainBoost;
        for (let i = 0; i < catTokens.length; i++) {
          if (tokenSet.has(catTokens[i])) hitCount++;
        }
        if (hitCount < 2) continue;

        // Collect actual hits only after passing the count check
        const hits: string[] = [];
        for (let i = 0; i < catTokens.length; i++) {
          if (tokenSet.has(catTokens[i])) hits.push(catTokens[i]);
        }

        const leaf = this.ensureLeafLocal(
          cat.externalId,
          categories,
          parentMaps,
        );
        if (!leaf?.externalId) continue;

        // Also check resolved leaf for domain incompatibility
        if (leaf.externalId !== cat.externalId) {
          const leafPath = leaf.fullPath || leaf.name;
          const leafNorm = this.getCatTokenized(
            siteId,
            leaf.externalId,
            leafPath,
          ).normalized;
          if (this.isDomainIncompatible(detectedDomain, leafNorm, true))
            continue;
        }

        // IDF-weighted score: discount tokens that appear in many categories
        let idfScore = 0;
        for (let i = 0; i < hits.length; i++) {
          const ratio = (tokenFreq.get(hits[i]) || 1) * invTotalCats;
          idfScore += ratio > HIGH_FREQ_THRESHOLD ? 0.25 : 1.0;
        }
        // Domain boost adds a moderate score (not full 1.0) to avoid inflating confidence
        if (domainBoost) idfScore += 0.5;

        // Bigram boost: consecutive title tokens found together in category path
        let bigramBoost = 0;
        for (let i = 0; i < titleBigrams.length; i++) {
          if (catPathNorm.includes(titleBigrams[i])) bigramBoost += 3;
        }
        idfScore += bigramBoost;

        // Match ratio: what fraction of title tokens matched (real hits only, no domain boost)
        const matchRatio = hits.length / Math.max(tokens.length, 1);

        // Confidence: IDF-weighted, match-ratio-scaled.
        // For domain-boosted matches with few real token hits, use a floor
        // that's high enough to pass the frontend threshold (0.15) but
        // low enough to not auto-apply (< 0.65).
        let confidence = Math.min(1, (idfScore / 4) * 0.5 * matchRatio);
        // Domain boost guarantees a minimum confidence when there's at least 1 real hit
        if (domainBoost && hits.length >= 1 && confidence < 0.18) {
          confidence = 0.18;
        }

        // Minimum confidence floor for keyword matches
        const MIN_KEYWORD_CONFIDENCE = 0.08;
        if (confidence < MIN_KEYWORD_CONFIDENCE) continue;

        const score = idfScore + bigramBoost;
        const existing = suggestions.get(leaf.externalId);
        if (!existing || existing.score < score) {
          suggestions.set(leaf.externalId, {
            categoryId: leaf.externalId,
            fullPath: leaf.fullPath || leaf.name,
            score,
            source: "keyword",
            attributes: baseAttr,
            confidence,
            autoApply: false, // keyword-only never auto-applies
            reasons: [
              `fullPath keywords: ${hits.join(", ")}${domainBoost ? " +domínio" : ""}${bigramBoost > 0 ? " (bigrama)" : ""}`,
            ],
          });
        }
      }
    }

    // ── Soft fallback for non-MLB automotive products with 0 matches ──
    // When we detect automotive domain but the title's vocabulary doesn't
    // overlap the marketplace's generic category names (common on Shopee —
    // titles like "Luz Teto Palio 1996" have no tokens matching paths like
    // "Peças e Acessórios para Veículos > Iluminação Interna"), return a
    // curated set of leaf categories inside the automotive tree so the UI
    // can offer them as searchable starting points instead of dumping all.
    if (
      suggestions.size === 0 &&
      detectedDomain === "automotive" &&
      siteId !== "MLB"
    ) {
      const fallbackMarkers = ["veiculos", "automoveis", "automotiv"];
      let picked = 0;
      for (const cat of categories) {
        if (picked >= 20) break;
        const { normalized: catPathNorm } = this.getCatTokenized(
          siteId,
          cat.externalId,
          cat.fullPath || cat.name || "",
        );
        let inDomain = false;
        for (let m = 0; m < fallbackMarkers.length; m++) {
          if (catPathNorm.includes(fallbackMarkers[m])) {
            inDomain = true;
            break;
          }
        }
        if (!inDomain) continue;
        if (this.isDomainIncompatible("automotive", catPathNorm, true))
          continue;
        const leaf = this.ensureLeafLocal(
          cat.externalId,
          categories,
          parentMaps,
        );
        if (!leaf?.externalId) continue;
        if (suggestions.has(leaf.externalId)) continue;
        suggestions.set(leaf.externalId, {
          categoryId: leaf.externalId,
          fullPath: leaf.fullPath || leaf.name,
          score: 0.1,
          source: "keyword",
          attributes: baseAttr,
          confidence: 0.1,
          autoApply: false,
          reasons: ["fallback: árvore automotiva"],
        });
        picked++;
      }
    }

    // ── Fusão dos sinais de inferência com as sugestões atuais ──
    // Aditivo por construção: sugestão existente só pode GANHAR confiança
    // (max) ou autoApply (OR) — nunca é removida nem rebaixada. Candidato novo
    // passa pelos MESMOS filtros de folha e domínio do fluxo atual.
    if (inference.votes.length > 0) {
      try {
        const allVotes: CategoryVote[] = [...inference.votes];
        for (const s of suggestions.values()) {
          const strength = Math.max(0, Math.min(1, s.confidence ?? 0));
          if (strength <= 0) continue;
          allVotes.push({
            externalId: s.categoryId,
            strength,
            signal: s.source === "alias" ? "alias" : "keyword",
            reason: "",
          });
        }

        for (const cand of fuseVotes(allVotes)) {
          // Sem sinal NOVO votando nesta categoria não há nada a acrescentar
          // (só alias/keyword refundidos = o que a lista já diz).
          const hasNewSignal = cand.signals.some(
            (sig) => sig === "part-type-map" || sig === "catalog-stat",
          );
          if (!hasNewSignal) continue;

          const leaf = this.ensureLeafLocal(
            cand.externalId,
            categories,
            parentMaps,
          );
          if (!leaf?.externalId) continue;
          if (detectedDomain === "automotive") {
            const leafNorm = this.normalize(leaf.fullPath || leaf.name);
            if (this.isDomainIncompatible(detectedDomain, leafNorm, true))
              continue;
          }

          const fusedScore = Math.round(cand.confidence * 12 * 100) / 100;
          const existing = suggestions.get(leaf.externalId);
          if (existing) {
            existing.confidence = Math.max(
              existing.confidence ?? 0,
              cand.confidence,
            );
            existing.autoApply = existing.autoApply || shouldAutoApply(cand);
            existing.score = Math.max(existing.score, fusedScore);
            const reasons = existing.reasons ?? [];
            for (const r of cand.reasons) {
              if (!reasons.includes(r)) reasons.push(r);
            }
            existing.reasons = reasons;
            if (!existing.pieceType && inference.pieceType) {
              existing.pieceType = inference.pieceType;
            }
            // Cada fonte de inferência INDEPENDENTE que também votou nesta
            // categoria é um sinal a mais. Sem isto, a recalibragem do
            // auto-aplicar leria só o signalCount do alias/keyword original e
            // desligaria justamente o caso que a fusão existe para reconhecer:
            // dois sinais independentes concordando.
            existing.signalCount =
              (existing.signalCount ??
                (existing.source === "keyword" ? 1 : 2)) +
              cand.signals.filter(
                (sig) => sig === "part-type-map" || sig === "catalog-stat",
              ).length;
          } else {
            suggestions.set(leaf.externalId, {
              categoryId: leaf.externalId,
              fullPath: leaf.fullPath || leaf.name,
              score: fusedScore,
              source: cand.signals.includes("part-type-map")
                ? "curated"
                : "internal",
              attributes: baseAttr,
              confidence: cand.confidence,
              autoApply: shouldAutoApply(cand),
              reasons: cand.reasons,
              pieceType: inference.pieceType ?? undefined,
              signalCount: cand.signals.length,
            });
          }
        }
      } catch (err) {
        console.warn(
          "[CategorySuggestionService] fusão de inferência falhou (fail-open):",
          err,
        );
      }
    }

    // ── Sanity check: final validation pass ──
    const suggestionArr = Array.from(suggestions.values());
    const filtered: CategorySuggestion[] = [];
    for (let i = 0; i < suggestionArr.length; i++) {
      const s = suggestionArr[i];
      // Remove keyword-only suggestions below minimum confidence
      if (s.source === "keyword" && (s.confidence ?? 0) < 0.1) continue;
      // Final domain cross-check — reuse cached normalized path when available
      if (detectedDomain === "automotive") {
        const cached = this.catTokenCache.get(siteId)?.get(s.categoryId);
        const pathNorm = cached
          ? cached.normalized
          : this.normalize(s.fullPath);
        if (this.isDomainIncompatible(detectedDomain, pathNorm, true)) continue;
      }
      filtered.push(s);
    }

    // ── Restrição de nicho (MLB) — fonte única com a busca manual ──
    // Mantém só categorias sob a raiz veicular (MLB5672), inclusive para
    // títulos ambíguos (independe de detectedDomain, pois o app é de autopeças).
    // Fail-open em DOIS casos, sem cachear (evita servir lista não-filtrada por
    // até 1h após o sync): (1) árvore não sincronizada (set vazio); (2) o filtro
    // zeraria TODAS as sugestões — provável árvore parcial/dessincronizada, não
    // vale esconder autopeça legítima por dado incompleto ("nunca zera").
    // Shopee/Magalu seguem seus próprios caminhos (domainPathMarkers / hint).
    let scoped = filtered;
    let skipCache = false;
    if (siteId === "MLB") {
      try {
        const set = await getVehicleRootSet("MLB");
        if (set.size > 0) {
          const nicheFiltered = filtered.filter((s) => set.has(s.categoryId));
          if (nicheFiltered.length > 0) {
            scoped = nicheFiltered;
          } else if (filtered.length > 0) {
            skipCache = true; // fail-open: mantém 'filtered', não cacheia
          }
        } else {
          skipCache = true;
        }
      } catch {
        skipCache = true;
      }
    }

    // ── V2: coerência de qualificador + recalibragem do auto-aplicar ──
    // A régua contra o gabarito humano do ML mostrou o candidato carregando um
    // qualificador que o título não sustenta ("Retrovisores INTERNOS" para um
    // retrovisor lateral, 22 ocorrências) e auto-aplicação em 366 de 400 casos,
    // todos divergentes. Fica ANTES do sort porque mexe no `score`.
    if (isV2Enabled()) {
      const titleTokenSet = new Set(tokens);
      const kept: CategorySuggestion[] = [];
      for (const s of scoped) {
        const leafName = this.leafNameOf(s.fullPath);
        const verdict: CoherenceVerdict = coherenceVerdict(
          titleTokenSet,
          new Set(this.tokenize(leafName)),
        );
        if (verdict === "block") continue;

        const confidence =
          verdict === "penalize"
            ? (s.confidence ?? 0) * COHERENCE_PENALTY
            : s.confidence;
        kept.push({
          ...s,
          score: verdict === "penalize" ? s.score * COHERENCE_PENALTY : s.score,
          confidence,
          autoApply: shouldAutoApplyV2({
            confidence: confidence ?? 0,
            signalCount: this.signalCountOf(s),
            coherence: verdict,
          }),
          signalCount: this.signalCountOf(s),
          reasons:
            verdict === "penalize"
              ? [
                  ...(s.reasons ?? []),
                  "penalizada: a categoria tem um qualificador que o título não menciona",
                ]
              : s.reasons,
        });
      }
      // Nunca zera: se a coerência derrubar tudo, mantém a lista anterior. O
      // guard existe para desempatar, não para esconder a única resposta.
      scoped = kept.length > 0 ? kept : scoped;
    }

    scoped.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.fullPath || "").length - (a.fullPath || "").length;
    });

    const elapsed = Date.now() - startedAt;
    if (elapsed > 3000) {
      console.warn(
        `[CategorySuggestionService] suggestFromTitle lento: ${elapsed}ms (title="${title}")`,
      );
    }

    const result = {
      normalizedTitle,
      tokens,
      suggestions: scoped.slice(0, 5),
    };

    if (!skipCache) {
      if (this.suggestResultCache.size >= this.SUGGEST_CACHE_MAX_ENTRIES) {
        const firstKey = this.suggestResultCache.keys().next().value;
        if (firstKey !== undefined) this.suggestResultCache.delete(firstKey);
      }
      this.suggestResultCache.set(cacheKey, { cachedAt: Date.now(), result });
    }

    return result;
  }
}

export default CategorySuggestionService;
