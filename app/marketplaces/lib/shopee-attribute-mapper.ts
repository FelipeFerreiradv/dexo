/**
 * Mapeamento dos dados do produto para a ficha técnica (`attribute_list`) de
 * uma categoria da Shopee.
 *
 * Por que existe: até aqui o caminho de publicação Shopee conhecia 4 campos do
 * produto (brand, model, year, partNumber) em 17 chaves hardcoded, casava por
 * nome EXATO em minúsculas e descartava com `continue` tudo que não casasse e
 * não fosse obrigatório. A ficha técnica dinâmica (`product.attributes`), que o
 * operador preenche e o Mercado Livre já usa, nunca era lida. Medido em
 * produção nas 3 categorias mais usadas: 1 de 12 atributos preenchidos
 * (categoria 102298, 1.161 anúncios), 2 de 11 (102416) e 1 de 13 (102532).
 *
 * Decisões que este módulo materializa, todas apoiadas nos schemas reais
 * lidos do cache de 156 categorias (`ShopeeCategoryAttribute`):
 *
 *  1. Os nomes de atributo da Shopee vêm em INGLÊS ("Car brand", "Item
 *     condition", "Origin", "Side", "Positions"), não em português. Por isso o
 *     casamento primário é por `attribute_id`, que é estável e imune a locale;
 *     o nome normalizado é só o desempate para categorias fora da amostra.
 *
 *  2. `Model` (101639) NÃO é o modelo do carro. Os valores reais publicados
 *     pelas categorias são linha de produto ("MAX", "PREMIUM", "TOR",
 *     "Bandeja"). Enviar `product.model = "Argo"` para lá é publicar dado
 *     errado num campo que o comprador filtra. Aqui ele é `exactEnumOnly`:
 *     só sai se casar exatamente com um valor que a própria categoria publicou.
 *
 *  3. Nada é inventado. Atributo sem fonte real no produto só é preenchido
 *     quando é obrigatório, e aí via valor neutro do catálogo — sempre
 *     reportado em `report.fallbacks` para aparecer no log.
 *
 * Puro de propósito (sem rede, sem Prisma, sem React), como
 * `ml-position.logic.ts`: é o que permite testar a matriz de tipos de atributo
 * sem mockar a API da Shopee.
 */

import {
  inferPositionFromName,
  resolvePositionValue,
} from "./ml-position.logic";

// ──────────────────────────────────────────────────────────
// Tipos de entrada
// ──────────────────────────────────────────────────────────

/**
 * Espelha `ShopeeCategoryAttribute` (types/shopee-api.types.ts) tolerando
 * schemas cacheados antes de alguns campos existirem.
 */
export interface ShopeeAttrSchema {
  attribute_id: number;
  attribute_name: string;
  is_mandatory?: boolean;
  /**
   * Numérico-como-string ("1".."5"), do jeito que o adapter da API grava.
   * "" ou ausente em cache legado.
   */
  input_type?: string;
  /** Unidades no nível do ATRIBUTO (ex.: ["g","kg"]). */
  attribute_unit?: string[];
  attribute_value_list?: Array<{
    value_id: number;
    value_name: string;
    has_mandatory_children?: boolean;
  }>;
}

/**
 * Subconjunto do Product que o mapper lê. Estrutural de propósito: aceita o
 * Product do Prisma e o retorno de `applyOverridesToProduct` sem cast.
 */
export interface ShopeeMapperProduct {
  name?: string | null;
  sku?: string | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  partNumber?: string | null;
  quality?: string | null;
  sourceVehicle?: string | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  weightKg?: number | { toNumber(): number } | null;
  /** Ficha técnica dinâmica preenchida pelo operador. */
  attributes?: Record<string, unknown> | null;
  compatibilities?: Array<{
    brand?: string | null;
    model?: string | null;
    version?: string | null;
  }> | null;
}

export interface BuildShopeeAttributeListInput {
  product: ShopeeMapperProduct;
  categoryAttrs: ShopeeAttrSchema[];
  /**
   * Injetado pelo caller (= `ListingUseCase.pickSafeMandatoryShopeeValue`).
   * Injeção e não import para evitar o ciclo lib/ → usecase e para manter o
   * método estático — e o spec que o cobre — intocados.
   */
  pickSafeMandatoryValue: (
    values: Array<{
      value_id: number;
      value_name: string;
      has_mandatory_children?: boolean;
    }>,
  ) => { value_id: number; value_name: string };
  options?: {
    /**
     * true (default): reproduz o fallback legado (`brand || name`) para
     * atributo obrigatório de texto livre sem dado. Mantém a paridade com o
     * comportamento atual. false: não polui o anúncio, só reporta.
     */
    legacyMandatoryFallback?: boolean;
  };
}

// ──────────────────────────────────────────────────────────
// Tipos de saída
// ──────────────────────────────────────────────────────────

/** 1=SINGLE_DROP_DOWN 2=SINGLE_COMBO_BOX 3=FREE_TEXT 4=MULTI_DROP_DOWN 5=MULTI_COMBO_BOX */
export type ShopeeInputType = 1 | 2 | 3 | 4 | 5 | null;

export type MapStrategy =
  | "product_field"
  | "operator_attributes"
  | "position_inference"
  | "derived_quality"
  | "derived_dimension"
  | "derived_weight"
  | "neutral_enum"
  | "legacy_text_fallback";

export type MatchKind =
  | "exact"
  | "token_root"
  | "numeric_unit"
  | "free_text"
  | "neutral"
  | "unmatched";

export interface ShopeeAttributeReportEntry {
  attributeId: number;
  attributeName: string;
  isMandatory: boolean;
  inputType: ShopeeInputType;
  emitted: boolean;
  strategy: MapStrategy | null;
  /** Campo do Product ou id da chave em `product.attributes`. */
  sourceField: string | null;
  match: MatchKind;
  valueId: number | null;
  valueName: string | null;
  valueUnit: string | null;
  /** Código estável do motivo — preenchido quando não emitiu ou degradou. */
  reason: string | null;
}

export interface ShopeeAttributeReport {
  categoryAttrCount: number;
  mandatoryCount: number;
  emittedCount: number;
  mandatoryEmittedCount: number;
  /** emittedCount / categoryAttrCount, 0..1. */
  coverage: number;
  entries: ShopeeAttributeReportEntry[];
  unmapped: ShopeeAttributeReportEntry[];
  fallbacks: ShopeeAttributeReportEntry[];
  hasUnfilledMandatory: boolean;
}

export interface ShopeeAttributeValueOut {
  value_id: number;
  original_value_name: string;
  value_unit?: string;
}

export interface ShopeeAttributeOut {
  attribute_id: number;
  attribute_name: string;
  attribute_value_list: ShopeeAttributeValueOut[];
}

// ──────────────────────────────────────────────────────────
// Helpers puros (exportados para teste direto)
// ──────────────────────────────────────────────────────────

/** NFD + sem diacrítico + lowercase + espaços colapsados + sem pontuação. */
export function normalizeAttrText(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function parseInputType(raw?: string): ShopeeInputType {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n >= 1 && n <= 5) return n as ShopeeInputType;
  return null;
}

/**
 * Combo box aceita valor fora da lista publicada (é o que explica tantas
 * categorias com `attribute_value_list` vazio). Drop-down é lista fechada.
 * Tipo desconhecido é tratado como fechado — conservador de propósito.
 */
export function acceptsFreeText(t: ShopeeInputType): boolean {
  return t === 2 || t === 3 || t === 5;
}

/** "27.5" → "27.5 cm" (formato que a Shopee publica nos enums de dimensão). */
export function formatCm(n: number): string {
  const v = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  return `${v} cm`;
}

/**
 * Escolhe unidade de peso conforme o que a categoria aceita. < 1 kg vira
 * gramas, que é como a Shopee publica os valores de autopeça leve.
 */
export function pickWeightUnit(
  kg: number,
  units: string[],
): { value: string; unit: string } | null {
  const has = (u: string) => units.some((x) => x.toLowerCase() === u);
  if (kg >= 1 && has("kg")) {
    return { value: String(Number(kg.toFixed(3))), unit: "kg" };
  }
  if (has("g")) {
    return { value: String(Math.round(kg * 1000)), unit: "g" };
  }
  if (has("kg")) {
    return { value: String(Number(kg.toFixed(3))), unit: "kg" };
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && typeof (v as any).toNumber === "function") {
    const n = (v as any).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstNonEmpty(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// Dicionário
// ──────────────────────────────────────────────────────────

type ResolverId =
  | "partNumber"
  | "carBrand"
  | "model"
  | "sku"
  | "condition_en"
  | "condition_pt"
  | "material"
  | "position"
  | "weight"
  | "dimensionAll"
  | "lengthCm"
  | "widthCm"
  | "heightCm";

export interface ShopeeAttrDictionaryEntry {
  /** Casamento primário: id oficial da Shopee. */
  ids: number[];
  /** Desempate por nome normalizado (inglês canônico + aliases pt-BR). */
  names: string[];
  resolver: ResolverId;
  /** Só emite com match exato no enum publicado; nunca texto livre. */
  exactEnumOnly?: boolean;
}

/**
 * Ids e nomes conferidos contra os schemas reais de 156 categorias em cache.
 * A coluna "em N categorias" abaixo é a frequência observada em produção.
 */
export const SHOPEE_ATTR_DICTIONARY: ShopeeAttrDictionaryEntry[] = [
  // 144 categorias, obrigatório em 85 — o atributo mais importante da vertical.
  {
    ids: [102293],
    names: [
      "auto part number",
      "auto-part number",
      "part number",
      "part number oem",
      "oem part number",
      "numero da peca",
      "numero de referencia",
      "reference number",
    ],
    resolver: "partNumber",
  },
  { ids: [101676], names: ["oem code", "codigo oem", "oem"], resolver: "partNumber" },
  // 112 categorias. Marca do VEÍCULO.
  {
    ids: [102200],
    names: ["car brand", "marca do carro", "marca do veiculo", "montadora", "automaker"],
    resolver: "carBrand",
  },
  // 46 categorias — e NÃO é modelo de carro. Ver nota 2 no topo do arquivo.
  {
    ids: [101639],
    names: ["model", "modelo"],
    resolver: "model",
    exactEnumOnly: true,
  },
  { ids: [101643], names: ["sku", "codigo", "referencia interna"], resolver: "sku" },
  // 22 categorias, valores em inglês (New/Refurbished/Used).
  { ids: [100413], names: ["condition", "condicao", "estado"], resolver: "condition_en" },
  // 131 categorias, valores em português ("Novo").
  { ids: [101638], names: ["item condition", "condicao do item"], resolver: "condition_pt" },
  { ids: [100134], names: ["material"], resolver: "material" },
  // Lado/posição: reuso integral da lógica já usada no Mercado Livre.
  { ids: [101674], names: ["side", "lado"], resolver: "position" },
  { ids: [101933], names: ["positions", "posicoes"], resolver: "position" },
  { ids: [100911], names: ["position", "posicao"], resolver: "position" },
  // 149 e 63 categorias. attribute_unit costuma trazer ["g","kg"].
  { ids: [100095], names: ["weight", "peso"], resolver: "weight" },
  { ids: [101650], names: ["package weight", "peso da embalagem"], resolver: "weight" },
  // 151 categorias, texto livre.
  {
    ids: [100942],
    names: ["dimension l x w x h", "dimensoes", "dimensao"],
    resolver: "dimensionAll",
  },
  { ids: [101649], names: ["packaging length", "comprimento da embalagem"], resolver: "lengthCm" },
  { ids: [101651], names: ["packaging width", "largura da embalagem"], resolver: "widthCm" },
  { ids: [101648], names: ["package height", "altura da embalagem"], resolver: "heightCm" },
];

/** Mapa do enum Quality → valor publicado pela Shopee, por idioma do atributo. */
const QUALITY_TO_CONDITION_EN: Record<string, string> = {
  NOVO: "New",
  RECONDICIONADO: "Refurbished",
  SEMINOVO: "Used",
  SUCATA: "Used",
};
const QUALITY_TO_CONDITION_PT: Record<string, string> = {
  NOVO: "Novo",
  RECONDICIONADO: "Recondicionado",
  SEMINOVO: "Usado",
  SUCATA: "Usado",
};

// ──────────────────────────────────────────────────────────
// Motor
// ──────────────────────────────────────────────────────────

interface ResolvedValue {
  value: string;
  strategy: MapStrategy;
  sourceField: string;
  unit?: string;
  /** Candidato de posição já resolvido contra o enum da categoria. */
  positionValueId?: number;
}

function resolveFromDictionary(
  entry: ShopeeAttrDictionaryEntry,
  attr: ShopeeAttrSchema,
  product: ShopeeMapperProduct,
): ResolvedValue | null {
  switch (entry.resolver) {
    case "partNumber": {
      const v = firstNonEmpty(product.partNumber);
      return v
        ? { value: v, strategy: "product_field", sourceField: "partNumber" }
        : null;
    }
    case "carBrand": {
      // Uma única marca distinta nas compatibilidades é inequivocamente a
      // montadora. Com mais de uma (ou nenhuma), cai em product.brand.
      const marcas = Array.from(
        new Set(
          (product.compatibilities ?? [])
            .map((c) => (c?.brand ?? "").trim())
            .filter(Boolean),
        ),
      );
      if (marcas.length === 1) {
        return {
          value: marcas[0],
          strategy: "product_field",
          sourceField: "compatibilities[].brand",
        };
      }
      const v = firstNonEmpty(product.brand);
      return v
        ? { value: v, strategy: "product_field", sourceField: "brand" }
        : null;
    }
    case "model": {
      const v = firstNonEmpty(product.model);
      return v
        ? { value: v, strategy: "product_field", sourceField: "model" }
        : null;
    }
    case "sku": {
      const v = firstNonEmpty(product.sku);
      return v ? { value: v, strategy: "product_field", sourceField: "sku" } : null;
    }
    case "condition_en":
    case "condition_pt": {
      const q = (product.quality ?? "").toString().toUpperCase();
      const table =
        entry.resolver === "condition_en"
          ? QUALITY_TO_CONDITION_EN
          : QUALITY_TO_CONDITION_PT;
      // Quality é opcional e o banco tem valores legados fora do enum; o
      // default "usado" é o conservador para desmonte.
      const v = table[q] ?? (entry.resolver === "condition_en" ? "Used" : "Usado");
      return { value: v, strategy: "derived_quality", sourceField: "quality" };
    }
    case "material": {
      // Não há campo `material` no Product — só a ficha do operador alimenta.
      return null;
    }
    case "position": {
      const inferred = inferPositionFromName(product.name ?? "");
      if (!inferred) return null;
      const allowed = (attr.attribute_value_list ?? []).map((v) => ({
        id: String(v.value_id),
        name: v.value_name,
      }));
      const resolved = resolvePositionValue(inferred, allowed);
      if (!resolved) return null;
      return {
        value: resolved.valueName,
        strategy: "position_inference",
        sourceField: "name",
        positionValueId: resolved.valueId ? Number(resolved.valueId) : undefined,
      };
    }
    case "weight": {
      const kg = toNumber(product.weightKg);
      if (kg == null || kg <= 0) return null;
      const units = attr.attribute_unit ?? [];
      if (units.length > 0) {
        const picked = pickWeightUnit(kg, units);
        if (picked) {
          return {
            value: picked.value,
            unit: picked.unit,
            strategy: "derived_weight",
            sourceField: "weightKg",
          };
        }
      }
      // Sem unidades declaradas: emite no formato que os enums publicam.
      const asText = kg >= 1 ? `${Number(kg.toFixed(3))} kg` : `${Math.round(kg * 1000)} g`;
      return { value: asText, strategy: "derived_weight", sourceField: "weightKg" };
    }
    case "dimensionAll": {
      const l = toNumber(product.lengthCm);
      const w = toNumber(product.widthCm);
      const h = toNumber(product.heightCm);
      if (!l || !w || !h) return null;
      return {
        value: `${l} x ${w} x ${h} cm`,
        strategy: "derived_dimension",
        sourceField: "lengthCm/widthCm/heightCm",
      };
    }
    case "lengthCm":
    case "widthCm":
    case "heightCm": {
      const n = toNumber(
        entry.resolver === "lengthCm"
          ? product.lengthCm
          : entry.resolver === "widthCm"
            ? product.widthCm
            : product.heightCm,
      );
      if (!n || n <= 0) return null;
      return {
        value: formatCm(n),
        strategy: "derived_dimension",
        sourceField: entry.resolver,
      };
    }
    default:
      return null;
  }
}

/**
 * Lê a ficha técnica do operador para este atributo. Aceita a chave como id
 * numérico (o formato do ML e o mais confiável) ou como nome normalizado.
 * O valor pode ser `{ value_id, value_name }` ou string crua.
 */
function resolveFromOperator(
  attr: ShopeeAttrSchema,
  attrs: Record<string, unknown> | null | undefined,
): ResolvedValue | null {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return null;

  const direto = attrs[String(attr.attribute_id)];
  let raw: unknown = direto;
  if (raw === undefined) {
    const alvo = normalizeAttrText(attr.attribute_name);
    for (const [k, v] of Object.entries(attrs)) {
      if (normalizeAttrText(k) === alvo) {
        raw = v;
        break;
      }
    }
  }
  if (raw == null) return null;

  if (typeof raw === "string") {
    const v = raw.trim();
    return v
      ? {
          value: v,
          strategy: "operator_attributes",
          sourceField: `attributes[${attr.attribute_id}]`,
        }
      : null;
  }
  if (typeof raw === "object") {
    const o = raw as { value_name?: unknown; value_id?: unknown };
    const name = typeof o.value_name === "string" ? o.value_name.trim() : "";
    if (name) {
      return {
        value: name,
        strategy: "operator_attributes",
        sourceField: `attributes[${attr.attribute_id}]`,
      };
    }
  }
  return null;
}

function findDictionaryEntry(
  attr: ShopeeAttrSchema,
): ShopeeAttrDictionaryEntry | null {
  const byId = SHOPEE_ATTR_DICTIONARY.find((e) =>
    e.ids.includes(attr.attribute_id),
  );
  if (byId) return byId;
  const nome = normalizeAttrText(attr.attribute_name);
  return (
    SHOPEE_ATTR_DICTIONARY.find((e) =>
      e.names.some((n) => normalizeAttrText(n) === nome),
    ) ?? null
  );
}

/**
 * Compara "10g" ≡ "10 g" ≡ "10G" e "27.5 cm" ≡ "27,5cm".
 *
 * Usa normalização PRÓPRIA (e não `normalizeAttrText`) porque aquela troca
 * pontuação por espaço — o que transformaria "2.5 kg" em "2 5 kg" e nenhum
 * peso decimal casaria com o enum da categoria.
 */
function numericUnitEquals(a: string, b: string): boolean {
  const parse = (s: string) => {
    const limpo = (s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(",", ".")
      .trim();
    const m = limpo.match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-z]*)$/);
    return m ? { n: Number(m[1]), u: m[2] } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  return pa.n === pb.n && pa.u === pb.u;
}

export function buildShopeeAttributeList(
  input: BuildShopeeAttributeListInput,
): { attributeList: ShopeeAttributeOut[]; report: ShopeeAttributeReport } {
  const { product, categoryAttrs, pickSafeMandatoryValue } = input;
  const legacyMandatoryFallback =
    input.options?.legacyMandatoryFallback !== false;

  const attributeList: ShopeeAttributeOut[] = [];
  const entries: ShopeeAttributeReportEntry[] = [];

  for (const attr of categoryAttrs) {
    const isMandatory = attr.is_mandatory === true;
    const inputType = parseInputType(attr.input_type);
    const enumList = attr.attribute_value_list ?? [];
    const dict = findDictionaryEntry(attr);
    const exactEnumOnly = dict?.exactEnumOnly === true;

    const base: ShopeeAttributeReportEntry = {
      attributeId: attr.attribute_id,
      attributeName: attr.attribute_name,
      isMandatory,
      inputType,
      emitted: false,
      strategy: null,
      sourceField: null,
      match: "unmatched",
      valueId: null,
      valueName: null,
      valueUnit: null,
      reason: null,
    };

    // Passo 0 — origem do valor. A ficha do operador VENCE a derivação, mesma
    // regra que buildMLAttributes já aplica ao POSITION: quem preencheu à mão
    // sabe mais que a inferência.
    const resolved =
      resolveFromOperator(attr, product.attributes) ??
      (dict ? resolveFromDictionary(dict, attr, product) : null);

    const push = (
      valueId: number,
      valueName: string,
      match: MatchKind,
      strategy: MapStrategy,
      sourceField: string | null,
      unit?: string,
      reason?: string,
    ) => {
      const out: ShopeeAttributeValueOut = {
        value_id: valueId,
        original_value_name: valueName,
      };
      if (unit) out.value_unit = unit;
      attributeList.push({
        attribute_id: attr.attribute_id,
        attribute_name: attr.attribute_name,
        attribute_value_list: [out],
      });
      entries.push({
        ...base,
        emitted: true,
        strategy,
        sourceField,
        match,
        valueId,
        valueName,
        valueUnit: unit ?? null,
        reason: reason ?? null,
      });
    };

    if (!resolved) {
      // Sem fonte. Obrigatório ainda precisa de algo; opcional é descartado —
      // mesma economia de payload do `continue` do código legado.
      if (!isMandatory) {
        entries.push({ ...base, reason: "no_source_field" });
        continue;
      }
      if (enumList.length > 0) {
        const picked = pickSafeMandatoryValue(enumList);
        push(
          picked.value_id,
          picked.value_name,
          "neutral",
          "neutral_enum",
          null,
          undefined,
          "mandatory_dropdown_neutral",
        );
        continue;
      }
      if (legacyMandatoryFallback) {
        const fallback = firstNonEmpty(product.brand, product.name);
        if (fallback) {
          push(
            0,
            fallback,
            "free_text",
            "legacy_text_fallback",
            "brand||name",
            undefined,
            "mandatory_free_text_no_data",
          );
          continue;
        }
      }
      entries.push({ ...base, reason: "mandatory_free_text_no_data" });
      continue;
    }

    // Passo 1 — a categoria publicou opções.
    if (enumList.length > 0) {
      // Posição já vem casada contra o enum por resolvePositionValue.
      if (resolved.positionValueId !== undefined) {
        push(
          resolved.positionValueId,
          resolved.value,
          "token_root",
          resolved.strategy,
          resolved.sourceField,
        );
        continue;
      }

      const alvo = normalizeAttrText(resolved.value);
      const exato = enumList.find(
        (v) => normalizeAttrText(v.value_name) === alvo,
      );
      if (exato) {
        push(
          exato.value_id,
          exato.value_name,
          "exact",
          resolved.strategy,
          resolved.sourceField,
        );
        continue;
      }

      const comUnidade = resolved.unit
        ? enumList.find((v) =>
            numericUnitEquals(v.value_name, `${resolved.value}${resolved.unit}`),
          )
        : enumList.find((v) => numericUnitEquals(v.value_name, resolved.value));
      if (comUnidade) {
        push(
          comUnidade.value_id,
          comUnidade.value_name,
          "numeric_unit",
          resolved.strategy,
          resolved.sourceField,
        );
        continue;
      }

      if (exactEnumOnly) {
        // O caso `Model`: nada casou, e o campo tem domínio próprio. Publicar
        // aqui seria publicar dado errado.
        entries.push({
          ...base,
          strategy: resolved.strategy,
          sourceField: resolved.sourceField,
          reason: "model_attr_exact_only",
        });
        continue;
      }

      if (acceptsFreeText(inputType)) {
        push(
          0,
          resolved.value,
          "free_text",
          resolved.strategy,
          resolved.sourceField,
          resolved.unit,
        );
        continue;
      }

      // Lista fechada (drop-down) ou tipo desconhecido: não inventa valor.
      if (isMandatory) {
        const picked = pickSafeMandatoryValue(enumList);
        push(
          picked.value_id,
          picked.value_name,
          "neutral",
          "neutral_enum",
          resolved.sourceField,
          undefined,
          "mandatory_dropdown_neutral",
        );
      } else {
        entries.push({
          ...base,
          strategy: resolved.strategy,
          sourceField: resolved.sourceField,
          reason: "closed_list_no_match",
        });
      }
      continue;
    }

    // Passo 2 — sem lista publicada (texto livre ou combo box vazio).
    if (exactEnumOnly) {
      entries.push({
        ...base,
        strategy: resolved.strategy,
        sourceField: resolved.sourceField,
        reason: "model_attr_exact_only",
      });
      continue;
    }
    // `value_unit` só quando a categoria declara aceitar aquela unidade.
    const unidadeOk =
      resolved.unit && (attr.attribute_unit ?? []).includes(resolved.unit)
        ? resolved.unit
        : undefined;
    push(
      0,
      resolved.value,
      "free_text",
      resolved.strategy,
      resolved.sourceField,
      unidadeOk,
      resolved.unit && !unidadeOk ? "unit_not_supported" : undefined,
    );
  }

  const mandatoryCount = entries.filter((e) => e.isMandatory).length;
  const emittedCount = entries.filter((e) => e.emitted).length;
  const mandatoryEmittedCount = entries.filter(
    (e) => e.isMandatory && e.emitted,
  ).length;

  const report: ShopeeAttributeReport = {
    categoryAttrCount: entries.length,
    mandatoryCount,
    emittedCount,
    mandatoryEmittedCount,
    coverage:
      entries.length > 0
        ? Number((emittedCount / entries.length).toFixed(4))
        : 0,
    entries,
    unmapped: entries.filter((e) => !e.emitted),
    fallbacks: entries.filter(
      (e) =>
        e.strategy === "neutral_enum" || e.strategy === "legacy_text_fallback",
    ),
    hasUnfilledMandatory: entries.some((e) => e.isMandatory && !e.emitted),
  };

  return { attributeList, report };
}
