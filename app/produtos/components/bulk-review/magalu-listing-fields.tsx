"use client";

// Campos de anúncio do Magalu para o modo "Revisão individual".
//
// JSX NOVO (abordagem B/replicação) espelhando o passo Magalu do modal "Novo
// Produto" (create-product-dialog.tsx), controlado pelo `control` COMPARTILHADO.
// Não importa nem altera o modal. A categoria do Magalu é buscada SERVER-SIDE
// (não há lista finita sincronizada como ML/Shopee) — mesmo padrão do modal —,
// e a sugestão automática (no hook) pré-preenche `magaluCategory`/`Label`.
// Quando vazia, o backend resolve a categoria no envio (de-para/busca → DRAFT).

import { useEffect, useState } from "react";
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
import { getApiBaseUrl } from "@/lib/api";
import type {
  PerProductListingConfig,
  ReviewAccountLite,
  ReviewCategoryOption,
} from "./per-product-types";

export interface MagaluListingFieldsProps {
  control: Control<PerProductListingConfig>;
  setValue: UseFormSetValue<PerProductListingConfig>;
  watch: UseFormWatch<PerProductListingConfig>;
  magaluAccounts: ReviewAccountLite[];
  email: string;
}

// path "A/B/C" → breadcrumb "A > B > C" (igual ML/Shopee/modal).
function fmtPath(v: string): string {
  return v
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" > ");
}

export function MagaluListingFields({
  control,
  setValue,
  watch,
  magaluAccounts,
  email,
}: MagaluListingFieldsProps) {
  const [categorySearch, setCategorySearch] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [options, setOptions] = useState<ReviewCategoryOption[]>([]);
  const [loading, setLoading] = useState(false);

  const includeMagalu = watch("includeMagalu");
  const selectedAccountIds = watch("magaluAccountIds") ?? [];

  const toggleAccount = (id: string, checked: boolean) => {
    const cur = watch("magaluAccountIds") ?? [];
    const next = checked
      ? Array.from(new Set([...cur, id]))
      : cur.filter((x) => x !== id);
    setValue("magaluAccountIds", next, { shouldDirty: true });
  };

  // Busca server-side de categorias Magalu (debounced) — espelha o modal.
  useEffect(() => {
    if (!includeMagalu) return;
    const term = categorySearch.trim();
    if (term.length < 2) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const resp = await fetch(
          `${getApiBaseUrl()}/marketplace/magalu/categories?search=${encodeURIComponent(
            term,
          )}`,
          { headers: { email } },
        );
        if (resp.ok) {
          const data = await resp.json();
          if (!cancelled)
            setOptions(Array.isArray(data?.categories) ? data.categories : []);
        }
      } catch {
        // fail-open: sem resultados ⇒ usuário mantém a sugestão / backend resolve
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [categorySearch, includeMagalu, email]);

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Controller
          name="includeMagalu"
          control={control}
          render={({ field }) => (
            <Switch
              id="pp-includeMagalu"
              checked={field.value || false}
              onCheckedChange={field.onChange}
              disabled={magaluAccounts.length === 0}
            />
          )}
        />
        <Label htmlFor="pp-includeMagalu" className="cursor-pointer font-medium">
          Anunciar no Magalu
        </Label>
      </div>

      {magaluAccounts.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nenhuma conta do Magalu selecionada na etapa Marketplaces.
        </p>
      )}

      {includeMagalu && magaluAccounts.length > 0 && (
        <div className="space-y-4">
          {/* Contas */}
          <div className="space-y-2">
            <Label>Contas do Magalu</Label>
            <div className="space-y-2 rounded-md border p-3">
              {magaluAccounts.map((acc) => (
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
                    {acc.accountName || "Conta Magalu"}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Desmarque uma conta para não publicar este produto nela.
            </p>
          </div>

          {/* Categoria (busca server-side) */}
          <div className="space-y-2">
            <Label>Categoria no Magalu</Label>
            <Controller
              name="magaluCategory"
              control={control}
              render={({ field }) => {
                const rawLabel =
                  watch("magaluCategoryLabel") ||
                  options.find((o) => o.id === field.value)?.value ||
                  "";
                const selectedLabel = rawLabel ? fmtPath(rawLabel) : "";
                const term = categorySearch.trim();
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
                          placeholder="Buscar categoria do Magalu..."
                          value={categorySearch}
                          onChange={(e) => setCategorySearch(e.target.value)}
                          onBlur={() => {
                            setTimeout(() => setDropdownOpen(false), 200);
                          }}
                          autoFocus={dropdownOpen}
                        />
                        {term && options.length > 0 && (
                          <div className="absolute z-50 mt-1 w-full max-h-48 overflow-auto rounded-md border bg-background shadow-md">
                            {options.map((o) => (
                              <button
                                type="button"
                                key={o.id}
                                className={`w-full px-3 py-2 text-left text-sm hover:bg-accent ${
                                  o.id === field.value
                                    ? "bg-accent font-medium"
                                    : ""
                                }`}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  field.onChange(o.id);
                                  setValue("magaluCategoryLabel", o.value, {
                                    shouldDirty: true,
                                  });
                                  setCategorySearch("");
                                  setDropdownOpen(false);
                                }}
                              >
                                {fmtPath(o.value)}
                              </button>
                            ))}
                          </div>
                        )}
                        {term && !loading && options.length === 0 && (
                          <div className="absolute z-50 mt-1 w-full rounded-md border bg-background shadow-md px-3 py-2 text-sm text-muted-foreground">
                            Nenhuma categoria encontrada
                          </div>
                        )}
                        {loading && (
                          <div className="absolute z-50 mt-1 w-full rounded-md border bg-background shadow-md px-3 py-2 text-sm text-muted-foreground">
                            Buscando…
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Em branco, a categoria é resolvida automaticamente no envio. A
              categoria automática preenche uma sugestão (com nome).
            </p>
          </div>

          {/* Mesmo campo, rótulo e helper text do ML (ml-listing-fields.tsx). */}
          <div className="space-y-2">
            <Label htmlFor="pp-magaluListingPrice">Valor do Anúncio (R$)</Label>
            <Controller
              name="magaluListingPrice"
              control={control}
              render={({ field }) => (
                <CurrencyInput
                  id="pp-magaluListingPrice"
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
