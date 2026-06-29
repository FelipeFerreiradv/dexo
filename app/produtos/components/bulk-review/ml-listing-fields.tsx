"use client";

// Campos de anúncio do Mercado Livre para o modo "Revisão individual".
//
// JSX NOVO (abordagem B/replicação) que espelha a etapa 6 do modal "Novo
// Produto", mas controlado pelo `control` COMPARTILHADO do modo Revisão — o
// modal `create-product-dialog.tsx` NÃO é importado nem alterado. Reusa as peças
// já isoladas: MLDynamicAttributesSection e MLCatalogSuggestionPicker.

import { useMemo, useState } from "react";
import {
  Controller,
  type Control,
  type UseFormSetValue,
  type UseFormWatch,
} from "react-hook-form";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ML_CATEGORY_OPTIONS } from "@/app/lib/product-parser";
import { MLDynamicAttributesSection } from "../ml-dynamic-attributes-section";
import { MLCatalogSuggestionPicker } from "../ml-catalog-suggestion-picker";
import type { CatalogProductDetail } from "../../../marketplaces/usecases/ml-catalog-suggestion.usecase";
import type {
  PerProductListingConfig,
  ReviewAccountLite,
  ReviewCategoryOption,
} from "./per-product-types";

export interface MlListingFieldsProps {
  control: Control<PerProductListingConfig>;
  setValue: UseFormSetValue<PerProductListingConfig>;
  watch: UseFormWatch<PerProductListingConfig>;
  productName: string;
  mlAccounts: ReviewAccountLite[];
  mlOptions: ReviewCategoryOption[];
  email: string;
}

function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function MlListingFields({
  control,
  setValue,
  watch,
  productName,
  mlAccounts,
  mlOptions,
  email,
}: MlListingFieldsProps) {
  const [categorySearch, setCategorySearch] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const normalizedOptions = useMemo(() => {
    const src =
      mlOptions && mlOptions.length > 0
        ? mlOptions
        : ML_CATEGORY_OPTIONS.map((c) => ({ id: c.id, value: c.value }));
    return src.map((o) => ({
      id: o.id,
      value: o.value,
      norm: normalizeText(o.value),
    }));
  }, [mlOptions]);

  const includeMl = watch("includeMl");
  const mlCategory = watch("mlCategory");
  const selectedAccountIds = watch("mlAccountIds") ?? [];

  const toggleAccount = (id: string, checked: boolean) => {
    const cur = watch("mlAccountIds") ?? [];
    const next = checked
      ? Array.from(new Set([...cur, id]))
      : cur.filter((x) => x !== id);
    setValue("mlAccountIds", next, { shouldDirty: true });
  };

  const handleCatalogAccept = (detail: CatalogProductDetail) => {
    setValue("mlCatalogProductId", detail.catalogProductId, {
      shouldDirty: true,
    });
    if (detail.categoryId)
      setValue("mlCategory", detail.categoryId, { shouldDirty: true });
    if (detail.attributes && Object.keys(detail.attributes).length > 0) {
      const cur = watch("attributes") ?? {};
      setValue(
        "attributes",
        { ...cur, ...detail.attributes },
        { shouldDirty: true },
      );
    }
  };

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Controller
          name="includeMl"
          control={control}
          render={({ field }) => (
            <Switch
              id="pp-includeMl"
              checked={field.value || false}
              onCheckedChange={field.onChange}
              disabled={mlAccounts.length === 0}
            />
          )}
        />
        <Label htmlFor="pp-includeMl" className="cursor-pointer font-medium">
          Anunciar no Mercado Livre
        </Label>
      </div>

      {mlAccounts.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nenhuma conta do Mercado Livre selecionada na etapa Marketplaces.
        </p>
      )}

      {includeMl && mlAccounts.length > 0 && (
        <div className="space-y-4">
          {/* Categoria */}
          <div className="space-y-2">
            <Label>Categoria no Mercado Livre</Label>
            <Controller
              name="mlCategory"
              control={control}
              render={({ field }) => {
                const selectedLabel = field.value
                  ? normalizedOptions.find((o) => o.id === field.value)
                      ?.value ||
                    watch("mlCategoryLabel") ||
                    undefined
                  : undefined;
                const searchNorm = normalizeText(categorySearch).trim();
                const filteredOptions = searchNorm
                  ? normalizedOptions
                      .filter((c) => c.norm.includes(searchNorm))
                      .slice(0, 50)
                  : [];
                return (
                  <div className="relative">
                    {selectedLabel && !dropdownOpen && (
                      <div
                        className="flex items-center justify-between rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-accent"
                        onClick={() => {
                          setDropdownOpen(true);
                          setCategorySearch("");
                        }}
                      >
                        <span className="truncate">{selectedLabel}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          Alterar
                        </span>
                      </div>
                    )}
                    {(dropdownOpen || !selectedLabel) && (
                      <>
                        <Input
                          placeholder="Buscar categoria do Mercado Livre..."
                          value={categorySearch}
                          onChange={(e) => setCategorySearch(e.target.value)}
                          onBlur={() => {
                            setTimeout(() => setDropdownOpen(false), 200);
                          }}
                          autoFocus={dropdownOpen}
                        />
                        {searchNorm && filteredOptions.length > 0 && (
                          <div className="absolute z-50 mt-1 w-full max-h-48 overflow-auto rounded-md border bg-background shadow-md">
                            {filteredOptions.map((cat) => (
                              <button
                                type="button"
                                key={cat.id}
                                className={`w-full px-3 py-2 text-left text-sm hover:bg-accent ${
                                  cat.id === field.value
                                    ? "bg-accent font-medium"
                                    : ""
                                }`}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  field.onChange(cat.id);
                                  setValue("mlCategoryLabel", cat.value, {
                                    shouldDirty: true,
                                  });
                                  setCategorySearch("");
                                  setDropdownOpen(false);
                                }}
                              >
                                {cat.value}
                              </button>
                            ))}
                          </div>
                        )}
                        {searchNorm && filteredOptions.length === 0 && (
                          <div className="absolute z-50 mt-1 w-full rounded-md border bg-background shadow-md px-3 py-2 text-sm text-muted-foreground">
                            Nenhuma categoria encontrada
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Em branco, será usada a categoria atual do produto. A categoria
              automática preenche uma sugestão (com nome).
            </p>

            <Controller
              name="attributes"
              control={control}
              render={({ field }) => (
                <MLDynamicAttributesSection
                  categoryId={mlCategory || ""}
                  value={(field.value as Record<string, never>) || {}}
                  onChange={(next) => field.onChange(next)}
                  email={email || undefined}
                />
              )}
            />

            <MLCatalogSuggestionPicker
              title={productName || ""}
              selectedId={watch("mlCatalogProductId")}
              onAccept={handleCatalogAccept}
              categoryIdFilter={mlCategory || null}
              email={email || null}
            />
          </div>

          {/* Contas */}
          <div className="space-y-2">
            <Label>Contas do Mercado Livre</Label>
            <div className="space-y-2 rounded-md border p-3">
              {mlAccounts.map((acc) => (
                <label
                  key={acc.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedAccountIds.includes(acc.id)}
                    onChange={(e) => toggleAccount(acc.id, e.target.checked)}
                  />
                  <span className="font-medium">
                    {acc.accountName || "Conta ML"}
                  </span>
                  {acc.status && (
                    <span className="text-xs text-muted-foreground">
                      ({acc.status})
                    </span>
                  )}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Desmarque uma conta para não publicar este produto nela.
            </p>
          </div>

          {/* Configurações do anúncio */}
          <div className="space-y-4 rounded-lg border border-border/50 p-4">
            <h4 className="text-sm font-semibold">Configurações do Anúncio</h4>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pp-mlListingType">Listagem do anúncio</Label>
                <Controller
                  name="mlListingType"
                  control={control}
                  render={({ field }) => (
                    <Select
                      onValueChange={field.onChange}
                      value={field.value ?? "gold_special"}
                    >
                      <SelectTrigger id="pp-mlListingType">
                        <SelectValue placeholder="Tipo de listagem" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="gold_premium">Premium</SelectItem>
                        <SelectItem value="gold_special">Clássico</SelectItem>
                        <SelectItem value="bronze">Grátis</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pp-mlItemCondition">Condição do item</Label>
                <Controller
                  name="mlItemCondition"
                  control={control}
                  render={({ field }) => (
                    <Select
                      onValueChange={field.onChange}
                      value={field.value ?? "used"}
                    >
                      <SelectTrigger id="pp-mlItemCondition">
                        <SelectValue placeholder="Condição" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="new">Novo</SelectItem>
                        <SelectItem value="used">Usado</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-border/40 p-3">
              <div className="flex items-center gap-3">
                <Controller
                  name="mlHasWarranty"
                  control={control}
                  render={({ field }) => (
                    <input
                      type="checkbox"
                      id="pp-mlHasWarranty"
                      checked={field.value || false}
                      onChange={(e) => field.onChange(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  )}
                />
                <Label
                  htmlFor="pp-mlHasWarranty"
                  className="cursor-pointer font-medium"
                >
                  Possui Garantia
                </Label>
              </div>

              {watch("mlHasWarranty") && (
                <div className="grid grid-cols-1 gap-4 pl-7 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="pp-mlWarrantyUnit">Garantia em</Label>
                    <Controller
                      name="mlWarrantyUnit"
                      control={control}
                      render={({ field }) => (
                        <Select
                          onValueChange={field.onChange}
                          value={field.value ?? "dias"}
                        >
                          <SelectTrigger id="pp-mlWarrantyUnit">
                            <SelectValue placeholder="Unidade" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="dias">Dias</SelectItem>
                            <SelectItem value="meses">Meses</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pp-mlWarrantyDuration">
                      Prazo da garantia
                    </Label>
                    <Controller
                      name="mlWarrantyDuration"
                      control={control}
                      render={({ field }) => (
                        <Input
                          id="pp-mlWarrantyDuration"
                          type="number"
                          min="1"
                          step="1"
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value === ""
                                ? null
                                : Number(e.target.value),
                            )
                          }
                        />
                      )}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pp-mlShippingMode">Frete</Label>
                <Controller
                  name="mlShippingMode"
                  control={control}
                  render={({ field }) => (
                    <Select
                      onValueChange={field.onChange}
                      value={field.value ?? "me2"}
                    >
                      <SelectTrigger id="pp-mlShippingMode">
                        <SelectValue placeholder="Tipo de frete" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="me2">Mercado Envios</SelectItem>
                        <SelectItem value="me1">Mercado Envios 1</SelectItem>
                        <SelectItem value="custom">Personalizado</SelectItem>
                        <SelectItem value="not_specified">
                          Não especificado
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pp-mlFreeShipping">Frete grátis</Label>
                <Controller
                  name="mlFreeShipping"
                  control={control}
                  render={({ field }) => (
                    <Select
                      onValueChange={(v) => field.onChange(v === "true")}
                      value={field.value ? "true" : "false"}
                    >
                      <SelectTrigger id="pp-mlFreeShipping">
                        <SelectValue placeholder="Frete grátis?" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">Sim</SelectItem>
                        <SelectItem value="false">Não</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pp-mlLocalPickup">Retirar pessoalmente</Label>
                <Controller
                  name="mlLocalPickup"
                  control={control}
                  render={({ field }) => (
                    <Select
                      onValueChange={(v) => field.onChange(v === "true")}
                      value={field.value ? "true" : "false"}
                    >
                      <SelectTrigger id="pp-mlLocalPickup">
                        <SelectValue placeholder="Retirar?" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">Sim</SelectItem>
                        <SelectItem value="false">Não</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pp-mlManufacturingTime">
                  Tempo de disponibilidade (Dias)
                </Label>
                <Controller
                  name="mlManufacturingTime"
                  control={control}
                  render={({ field }) => (
                    <Input
                      id="pp-mlManufacturingTime"
                      type="number"
                      min="0"
                      step="1"
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === ""
                            ? null
                            : Number(e.target.value),
                        )
                      }
                    />
                  )}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pp-mlListingPrice">Valor do Anúncio (R$)</Label>
              <Controller
                name="mlListingPrice"
                control={control}
                render={({ field }) => (
                  <CurrencyInput
                    id="pp-mlListingPrice"
                    placeholder="Usar preço de venda do produto"
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
              <p className="text-xs text-muted-foreground">
                Se não informado, será usado o preço de venda do produto.
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
