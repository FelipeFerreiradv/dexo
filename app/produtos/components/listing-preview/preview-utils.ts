// View-model builder for the read-only marketplace listing preview step.
//
// PURE module (no JSX, no React, no side effects) so it can be unit-tested in
// the node vitest environment and reused by the presentational mocks.
//
// IMPORTANT (price/title parity with the Revisão step): this module never
// formats currency on its own — it receives the SAME `formatCurrency` instance
// that the dialog/Revisão uses, guaranteeing the preview can never diverge from
// the review. ML price uses the effective listing price (`mlListingPrice ?? price`,
// the value the ML listing is actually created with); Shopee has no override and
// always uses `price`.

import { ML_CATEGORIES } from "@/app/lib/product-parser";

// ---- Inputs ---------------------------------------------------------------

/** Minimal, structurally-compatible subset of ProductFormData consumed here. */
export interface PreviewFormValues {
  name?: string;
  description?: string;
  imageUrl?: string;
  imageUrls?: string[];
  price?: number;
  stock?: number;
  mlListingPrice?: number | null;
  mlItemCondition?: string;
  mlFreeShipping?: boolean;
  mlHasWarranty?: boolean;
  mlWarrantyDuration?: number | null;
  mlWarrantyUnit?: string;
  mlCategory?: string;
  shopeeCategory?: string;
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  attributes?: Record<string, { value_id?: string; value_name?: string }>;
  createMLListing?: boolean;
  createShopeeListing?: boolean;
  createMagaluListing?: boolean;
}

export interface PreviewAccount {
  id: string;
  accountName: string;
}

export interface CategoryOption {
  id: string;
  value: string;
}

/** Compatibility row — structurally compatible with CompatibilityEntry. */
export interface PreviewCompatibility {
  brand: string;
  model: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  version?: string | null;
}

export interface BuildPreviewArgs {
  values: PreviewFormValues;
  compatibilities: PreviewCompatibility[];
  mlAccounts: PreviewAccount[];
  shopeeAccounts: PreviewAccount[];
  selectedMlAccountIds: string[];
  selectedShopeeAccountIds: string[];
  mlOptions: CategoryOption[];
  shopeeOptions: CategoryOption[];
  formatCurrency: (value: number | null | undefined) => string;
  // Magalu (opcionais p/ retrocompatibilidade dos chamadores/testes).
  magaluAccounts?: PreviewAccount[];
  selectedMagaluAccountIds?: string[];
}

// ---- Output ---------------------------------------------------------------

export interface ListingPreviewViewModel {
  /** Whether each marketplace preview should be shown (user opted to create). */
  showML: boolean;
  showShopee: boolean;
  showMagalu: boolean;

  title: string;
  description: string;
  images: string[];

  /** ML "Novo"/"Usado" badge. */
  condition: "Novo" | "Usado";

  /** Pre-formatted via the dialog's own formatCurrency (parity with Revisão). */
  mlPriceFormatted: string;
  shopeePriceFormatted: string;
  magaluPriceFormatted: string;

  /** ML free shipping (from mlFreeShipping). Shopee shipping is static/illustrative. */
  freeShipping: boolean;
  /** e.g. "90 dias" or null when no warranty. */
  warranty: string | null;
  stockLabel: string;

  /** Breadcrumbs already include a generic autopeças prefix + the chosen leaf. */
  mlBreadcrumb: string[];
  shopeeBreadcrumb: string[];
  /** Magalu: categoria é auto-resolvida no backend → breadcrumb genérico. */
  magaluBreadcrumb: string[];

  /** "O que você precisa saber" bullet rows (brand/model/year/version + attributes). */
  specs: Array<{ label: string; value: string }>;
  /** Short "Compatível com: …" summary, or null. */
  compatibilitySummary: string | null;
  compatibilities: PreviewCompatibility[];

  /** "Vendido por …" (ML) / store name (Shopee/Magalu). */
  mlAccountLabel: string;
  shopeeAccountLabel: string;
  magaluAccountLabel: string;
}

// Generic breadcrumbs used when no category is chosen (graceful degradation).
const ML_GENERIC_BREADCRUMB = [
  "Acessórios para Veículos",
  "Peças de Carros e Caminhonetes",
  "Peças de Interior",
];
const SHOPEE_GENERIC_BREADCRUMB = [
  "Shopee",
  "Acessórios para Veículos",
  "Peças de Reposição para Automóveis",
];
// Magalu resolve a categoria no backend (de-para/busca) — o modal não escolhe,
// então a prévia mostra o caminho de domínio genérico.
const MAGALU_GENERIC_BREADCRUMB = ["Veículos e Peças", "Autopeças"];

function resolveMlCategoryLeaf(
  values: PreviewFormValues,
  mlOptions: CategoryOption[],
): string {
  if (!values.mlCategory) return values.category?.trim() || "";
  // Same fallback chain the Revisão uses: backend-synced options first, then the
  // static ML_CATEGORIES tree, then the free-text category path.
  return (
    mlOptions.find((o) => o.id === values.mlCategory)?.value ||
    ML_CATEGORIES.find((c) => c.id === values.mlCategory)?.value ||
    values.category?.trim() ||
    ""
  );
}

function resolveShopeeCategoryLeaf(
  values: PreviewFormValues,
  shopeeOptions: CategoryOption[],
): string {
  if (!values.shopeeCategory) return "";
  return shopeeOptions.find((o) => o.id === values.shopeeCategory)?.value || "";
}

/** "Conta A" | "Conta A e mais 2" | fallback when nothing selected. */
function joinAccountNames(names: string[], fallback: string): string {
  const clean = names.map((n) => n?.trim()).filter(Boolean) as string[];
  if (clean.length === 0) return fallback;
  if (clean.length === 1) return clean[0];
  return `${clean[0]} e mais ${clean.length - 1}`;
}

function selectedAccountNames(
  accounts: PreviewAccount[],
  selectedIds: string[],
): string[] {
  const ids = new Set(selectedIds.filter(Boolean));
  return accounts.filter((a) => ids.has(a.id)).map((a) => a.accountName);
}

function buildWarranty(values: PreviewFormValues): string | null {
  if (!values.mlHasWarranty) return null;
  if (!values.mlWarrantyDuration || values.mlWarrantyDuration <= 0) return null;
  const unit = (values.mlWarrantyUnit || "dias").trim();
  return `${values.mlWarrantyDuration} ${unit}`;
}

function buildStockLabel(stock: number | undefined): string {
  if (stock === undefined || stock === null) return "Estoque disponível";
  if (stock <= 0) return "Sem estoque";
  if (stock === 1) return "Última em estoque!";
  return `Estoque disponível (${stock})`;
}

function buildSpecs(
  values: PreviewFormValues,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value?: string | null) => {
    const v = value?.toString().trim();
    if (v) rows.push({ label, value: v });
  };
  push("Marca", values.brand);
  push("Modelo", values.model);
  push("Ano", values.year);
  push("Versão", values.version);
  if (values.attributes) {
    for (const [key, attr] of Object.entries(values.attributes)) {
      const v = attr?.value_name?.trim();
      if (v) rows.push({ label: key, value: v });
    }
  }
  return rows;
}

function formatCompatibility(c: PreviewCompatibility): string {
  const parts: string[] = [c.brand, c.model].filter(Boolean) as string[];
  let label = parts.join(" ").trim();
  if (c.yearFrom) {
    const range =
      c.yearTo && c.yearTo !== c.yearFrom
        ? `${c.yearFrom}–${c.yearTo}`
        : `${c.yearFrom}`;
    label += ` (${range})`;
  }
  if (c.version) label += ` ${c.version}`;
  return label.trim();
}

function buildCompatibilitySummary(
  compatibilities: PreviewCompatibility[],
): string | null {
  if (!compatibilities || compatibilities.length === 0) return null;
  const labels = compatibilities
    .slice(0, 3)
    .map(formatCompatibility)
    .filter(Boolean);
  if (labels.length === 0) return null;
  const extra = compatibilities.length - labels.length;
  return extra > 0 ? `${labels.join(", ")} e mais ${extra}` : labels.join(", ");
}

export function buildPreviewViewModel(
  args: BuildPreviewArgs,
): ListingPreviewViewModel {
  const {
    values,
    compatibilities,
    mlAccounts,
    shopeeAccounts,
    selectedMlAccountIds,
    selectedShopeeAccountIds,
    mlOptions,
    shopeeOptions,
    formatCurrency,
    magaluAccounts,
    selectedMagaluAccountIds,
  } = args;

  const images =
    values.imageUrls && values.imageUrls.length > 0
      ? values.imageUrls.filter(Boolean)
      : values.imageUrl
        ? [values.imageUrl]
        : [];

  const mlLeaf = resolveMlCategoryLeaf(values, mlOptions);
  const shopeeLeaf = resolveShopeeCategoryLeaf(values, shopeeOptions);

  return {
    showML: !!values.createMLListing,
    showShopee: !!values.createShopeeListing,
    showMagalu: !!values.createMagaluListing,

    title: values.name?.trim() || "—",
    description: values.description?.trim() || "",
    images,

    condition: values.mlItemCondition === "used" ? "Usado" : "Novo",

    mlPriceFormatted: formatCurrency(values.mlListingPrice ?? values.price),
    shopeePriceFormatted: formatCurrency(values.price),
    magaluPriceFormatted: formatCurrency(values.price),

    freeShipping: !!values.mlFreeShipping,
    warranty: buildWarranty(values),
    stockLabel: buildStockLabel(values.stock),

    mlBreadcrumb: mlLeaf
      ? [...ML_GENERIC_BREADCRUMB, mlLeaf]
      : [...ML_GENERIC_BREADCRUMB],
    shopeeBreadcrumb: shopeeLeaf
      ? [...SHOPEE_GENERIC_BREADCRUMB, shopeeLeaf]
      : [...SHOPEE_GENERIC_BREADCRUMB],
    magaluBreadcrumb: [...MAGALU_GENERIC_BREADCRUMB],

    specs: buildSpecs(values),
    compatibilitySummary: buildCompatibilitySummary(compatibilities),
    compatibilities: compatibilities ?? [],

    mlAccountLabel: joinAccountNames(
      selectedAccountNames(mlAccounts, selectedMlAccountIds),
      "Sua conta Mercado Livre",
    ),
    shopeeAccountLabel: joinAccountNames(
      selectedAccountNames(shopeeAccounts, selectedShopeeAccountIds),
      "Sua loja Shopee",
    ),
    magaluAccountLabel: joinAccountNames(
      selectedAccountNames(
        magaluAccounts ?? [],
        selectedMagaluAccountIds ?? [],
      ),
      "Sua loja Magalu",
    ),
  };
}
