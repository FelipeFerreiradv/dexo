"use client";

// Campos de anúncio da Shopee para o modo "Revisão individual".
//
// JSX NOVO (abordagem B/replicação) espelhando a etapa 7 do modal "Novo
// Produto", controlado pelo `control` COMPARTILHADO. Não importa nem altera o
// modal. Categoria Shopee precisa ser FOLHA — quando inválida/ausente, a
// pendência aparece no preflight (igual ao de hoje), não bloqueia a navegação.

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
import type {
  PerProductListingConfig,
  ReviewAccountLite,
  ReviewCategoryOption,
} from "./per-product-types";

export interface ShopeeListingFieldsProps {
  control: Control<PerProductListingConfig>;
  setValue: UseFormSetValue<PerProductListingConfig>;
  watch: UseFormWatch<PerProductListingConfig>;
  shopeeAccounts: ReviewAccountLite[];
  shopeeOptions: ReviewCategoryOption[];
}

function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function ShopeeListingFields({
  control,
  setValue,
  watch,
  shopeeAccounts,
  shopeeOptions,
}: ShopeeListingFieldsProps) {
  const [categorySearch, setCategorySearch] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const normalizedOptions = useMemo(
    () =>
      shopeeOptions.map((o) => ({
        id: o.id,
        value: o.value,
        norm: normalizeText(o.value),
      })),
    [shopeeOptions],
  );

  const includeShopee = watch("includeShopee");
  const selectedAccountIds = watch("shopeeAccountIds") ?? [];

  const toggleAccount = (id: string, checked: boolean) => {
    const cur = watch("shopeeAccountIds") ?? [];
    const next = checked
      ? Array.from(new Set([...cur, id]))
      : cur.filter((x) => x !== id);
    setValue("shopeeAccountIds", next, { shouldDirty: true });
  };

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Controller
          name="includeShopee"
          control={control}
          render={({ field }) => (
            <Switch
              id="pp-includeShopee"
              checked={field.value || false}
              onCheckedChange={field.onChange}
              disabled={shopeeAccounts.length === 0}
            />
          )}
        />
        <Label htmlFor="pp-includeShopee" className="cursor-pointer font-medium">
          Anunciar na Shopee
        </Label>
      </div>

      {shopeeAccounts.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nenhuma conta da Shopee selecionada na etapa Marketplaces.
        </p>
      )}

      {includeShopee && shopeeAccounts.length > 0 && (
        <div className="space-y-4">
          {/* Contas */}
          <div className="space-y-2">
            <Label>Contas da Shopee</Label>
            <div className="space-y-2 rounded-md border p-3">
              {shopeeAccounts.map((acc) => (
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
                    {acc.accountName || "Conta Shopee"}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Desmarque uma conta para não publicar este produto nela.
            </p>
          </div>

          {/* Categoria */}
          <div className="space-y-2">
            <Label>Categoria na Shopee</Label>
            <Controller
              name="shopeeCategory"
              control={control}
              render={({ field }) => {
                const selectedLabel = field.value
                  ? normalizedOptions.find((o) => o.id === field.value)
                      ?.value ||
                    watch("shopeeCategoryLabel") ||
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
                          placeholder="Buscar categoria da Shopee..."
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
                                  setValue("shopeeCategoryLabel", cat.value, {
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
            {shopeeOptions.length === 0 && (
              <p className="text-xs text-yellow-600">
                Nenhuma categoria Shopee sincronizada. Vá em Integrações e
                sincronize as categorias da Shopee.
              </p>
            )}
          </div>

          {/* Mesmo campo, rótulo e helper text do ML (ml-listing-fields.tsx). */}
          <div className="space-y-2">
            <Label htmlFor="pp-shopeeListingPrice">Valor do Anúncio (R$)</Label>
            <Controller
              name="shopeeListingPrice"
              control={control}
              render={({ field }) => (
                <CurrencyInput
                  id="pp-shopeeListingPrice"
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
      )}
    </section>
  );
}
