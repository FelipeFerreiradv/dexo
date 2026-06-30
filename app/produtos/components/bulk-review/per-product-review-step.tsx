"use client";

// Painel "Produto X de N" do modo Revisão individual. Para o produto atual,
// renderiza (empilhado, fiel ao modal) a seção Mercado Livre e/ou Shopee
// (conforme as contas selecionadas globalmente) e a Prévia (StepPreview reusado).
//
// Performance (espelha o modal create-product-dialog.tsx): o componente PAI NÃO
// assina o form inteiro. A Prévia (cara) e o toggle de categoria automática ficam
// em filhos isolados que assinam o form via useWatch — assim, digitar num campo
// NÃO re-renderiza o painel todo, só o subtree que depende daquele valor.

import { useMemo } from "react";
import { useWatch, type Control } from "react-hook-form";
import Image from "next/image";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { StepPreview } from "../listing-preview/step-preview";
import type { PreviewFormValues } from "../listing-preview/preview-utils";
import { MlListingFields } from "./ml-listing-fields";
import { ShopeeListingFields } from "./shopee-listing-fields";
import { MagaluListingFields } from "./magalu-listing-fields";
import type { UsePerProductListingReturn } from "./use-per-product-listing";
import type {
  PerProductListingConfig,
  ReviewAccountLite,
  ReviewCategoryOption,
  ReviewProduct,
} from "./per-product-types";

const formatCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
};

/** Garante que a categoria selecionada apareça com NOME na Prévia mesmo que a
 * lista completa de categorias ainda não tenha carregado: injeta uma opção
 * sintética {id, value:rótuloCapturado}. Não altera resolução quando o id já
 * está na lista. */
function withSelectedLabel(
  options: ReviewCategoryOption[],
  id?: string,
  label?: string,
): ReviewCategoryOption[] {
  if (!id || !label) return options;
  if (options.some((o) => o.id === id)) return options;
  return [...options, { id, value: label }];
}

export interface PerProductReviewStepProps {
  pp: UsePerProductListingReturn;
  globalMlAccounts: ReviewAccountLite[];
  globalShopeeAccounts: ReviewAccountLite[];
  globalMagaluAccounts: ReviewAccountLite[];
  mlOptions: ReviewCategoryOption[];
  shopeeOptions: ReviewCategoryOption[];
  magaluOptions: ReviewCategoryOption[];
  preflightIssue?: { code: string; message: string };
  email: string;
}

export function PerProductReviewStep({
  pp,
  globalMlAccounts,
  globalShopeeAccounts,
  globalMagaluAccounts,
  mlOptions,
  shopeeOptions,
  magaluOptions,
  preflightIssue,
  email,
}: PerProductReviewStepProps) {
  const { form, current, index, total, initializing } = pp;

  if (!current) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin mr-2" />
        Carregando produto...
      </div>
    );
  }

  const thumb =
    current.imageUrl ||
    (Array.isArray(current.imageUrls) ? current.imageUrls[0] : null) ||
    null;

  const showMl = globalMlAccounts.length > 0;
  const showShopee = globalShopeeAccounts.length > 0;
  const showMagalu = globalMagaluAccounts.length > 0;

  return (
    <div className="space-y-4">
      {/* Cabeçalho do produto + navegação (não assina o form) */}
      <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
        <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md border bg-muted">
          {thumb ? (
            <Image
              src={thumb}
              alt={current.name}
              fill
              sizes="56px"
              className="object-cover"
              unoptimized
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">
              sem foto
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{current.name}</p>
          <p className="text-xs text-muted-foreground">SKU: {current.sku}</p>
        </div>
        <Badge variant="outline" className="shrink-0 font-normal">
          Produto {index + 1} de {total}
        </Badge>
      </div>

      {/* Categoria automática + pendência (assina só o campo autoCategory) */}
      <AutoCategoryRow
        control={form.control}
        onToggle={(v) => {
          form.setValue("autoCategory", v, { shouldDirty: true });
          if (v) pp.applyAutoCategory();
        }}
        initializing={initializing}
        preflightIssue={preflightIssue}
      />

      {/* Seções de anúncio (keadas por produto p/ resetar busca local) */}
      {showMl && (
        <MlListingFields
          key={`ml-${current.id}`}
          control={form.control}
          setValue={form.setValue}
          watch={form.watch}
          productName={current.name}
          mlAccounts={globalMlAccounts}
          mlOptions={mlOptions}
          email={email}
        />
      )}

      {showShopee && (
        <ShopeeListingFields
          key={`shopee-${current.id}`}
          control={form.control}
          setValue={form.setValue}
          watch={form.watch}
          shopeeAccounts={globalShopeeAccounts}
          shopeeOptions={shopeeOptions}
        />
      )}

      {showMagalu && (
        <MagaluListingFields
          key={`magalu-${current.id}`}
          control={form.control}
          setValue={form.setValue}
          watch={form.watch}
          magaluAccounts={globalMagaluAccounts}
          email={email}
        />
      )}

      {/* Prévia isolada: re-renderiza só ela quando um valor observado muda */}
      <LivePreview
        control={form.control}
        product={current}
        globalMlAccounts={globalMlAccounts}
        globalShopeeAccounts={globalShopeeAccounts}
        globalMagaluAccounts={globalMagaluAccounts}
        mlOptions={mlOptions}
        shopeeOptions={shopeeOptions}
        magaluOptions={magaluOptions}
      />
    </div>
  );
}

function AutoCategoryRow({
  control,
  onToggle,
  initializing,
  preflightIssue,
}: {
  control: Control<PerProductListingConfig>;
  onToggle: (v: boolean) => void;
  initializing: boolean;
  preflightIssue?: { code: string; message: string };
}) {
  const autoCategory = useWatch({ control, name: "autoCategory" });
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <Switch
          id="pp-autoCategory"
          checked={autoCategory ?? false}
          onCheckedChange={onToggle}
        />
        <Label
          htmlFor="pp-autoCategory"
          className="flex cursor-pointer items-center gap-1 text-sm"
        >
          <Sparkles className="size-3.5 text-muted-foreground" />
          Categoria automática
        </Label>
        {initializing && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            sugerindo...
          </span>
        )}
      </div>
      {preflightIssue && (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5" />
          {preflightIssue.message || "Categoria Shopee pendente"}
        </span>
      )}
    </div>
  );
}

function LivePreview({
  control,
  product,
  globalMlAccounts,
  globalShopeeAccounts,
  globalMagaluAccounts,
  mlOptions,
  shopeeOptions,
  magaluOptions,
}: {
  control: Control<PerProductListingConfig>;
  product: ReviewProduct;
  globalMlAccounts: ReviewAccountLite[];
  globalShopeeAccounts: ReviewAccountLite[];
  globalMagaluAccounts: ReviewAccountLite[];
  mlOptions: ReviewCategoryOption[];
  shopeeOptions: ReviewCategoryOption[];
  magaluOptions: ReviewCategoryOption[];
}) {
  // Assina TODO o form, mas isolado neste subtree: só a Prévia re-renderiza.
  const values = useWatch({ control }) as PerProductListingConfig;

  const previewValues: PreviewFormValues = {
    name: product.name,
    imageUrl: product.imageUrl ?? undefined,
    imageUrls: product.imageUrls ?? undefined,
    price: product.price,
    mlListingPrice: values.mlListingPrice,
    mlItemCondition: values.mlItemCondition,
    mlFreeShipping: values.mlFreeShipping,
    mlHasWarranty: values.mlHasWarranty,
    mlWarrantyDuration: values.mlWarrantyDuration,
    mlWarrantyUnit: values.mlWarrantyUnit,
    mlCategory: values.mlCategory,
    shopeeCategory: values.shopeeCategory,
    magaluCategory: values.magaluCategory,
    attributes: values.attributes,
    createMLListing: values.includeMl,
    createShopeeListing: values.includeShopee,
    createMagaluListing: values.includeMagalu,
  };

  // Resolve o NOME da categoria na Prévia mesmo antes de a lista de 12k carregar.
  const mlOptionsForPreview = useMemo(
    () =>
      withSelectedLabel(mlOptions, values.mlCategory, values.mlCategoryLabel),
    [mlOptions, values.mlCategory, values.mlCategoryLabel],
  );
  const shopeeOptionsForPreview = useMemo(
    () =>
      withSelectedLabel(
        shopeeOptions,
        values.shopeeCategory,
        values.shopeeCategoryLabel,
      ),
    [shopeeOptions, values.shopeeCategory, values.shopeeCategoryLabel],
  );
  // Magalu busca a categoria server-side (sem lista pré-carregada): a opção
  // sintética com o rótulo capturado resolve o caminho na Prévia.
  const magaluOptionsForPreview = useMemo(
    () =>
      withSelectedLabel(
        magaluOptions,
        values.magaluCategory,
        values.magaluCategoryLabel,
      ),
    [magaluOptions, values.magaluCategory, values.magaluCategoryLabel],
  );

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <h4 className="text-sm font-semibold">Prévia do anúncio</h4>
      <StepPreview
        values={previewValues}
        compatibilities={[]}
        mlAccounts={globalMlAccounts}
        shopeeAccounts={globalShopeeAccounts}
        selectedMlAccountIds={values.mlAccountIds ?? []}
        selectedShopeeAccountIds={values.shopeeAccountIds ?? []}
        mlOptions={mlOptionsForPreview}
        shopeeOptions={shopeeOptionsForPreview}
        formatCurrency={formatCurrency}
        magaluAccounts={globalMagaluAccounts}
        selectedMagaluAccountIds={values.magaluAccountIds ?? []}
        magaluOptions={magaluOptionsForPreview}
      />
    </div>
  );
}
