"use client";

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
import { getApiBaseUrl } from "@/lib/api";
import type {
  PerProductListingConfig,
  ReviewAccountLite,
  ReviewCategoryOption,
} from "./per-product-types";

export interface OlxListingFieldsProps {
  control: Control<PerProductListingConfig>;
  setValue: UseFormSetValue<PerProductListingConfig>;
  watch: UseFormWatch<PerProductListingConfig>;
  olxAccounts: ReviewAccountLite[];
  email: string;
}

function fmtPath(v: string): string {
  return v
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" > ");
}

export function OlxListingFields({
  control,
  setValue,
  watch,
  olxAccounts,
  email,
}: OlxListingFieldsProps) {
  const [categorySearch, setCategorySearch] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [options, setOptions] = useState<ReviewCategoryOption[]>([]);
  const [loading, setLoading] = useState(false);

  const includeOlx = watch("includeOlx");
  const selectedAccountIds = watch("olxAccountIds") ?? [];

  const toggleAccount = (id: string, checked: boolean) => {
    const cur = watch("olxAccountIds") ?? [];
    const next = checked
      ? Array.from(new Set([...cur, id]))
      : cur.filter((x) => x !== id);
    setValue("olxAccountIds", next, { shouldDirty: true });
  };

  useEffect(() => {
    if (!includeOlx) return;
    const term = categorySearch.trim();
    if (term.length < 2) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const resp = await fetch(
          `${getApiBaseUrl()}/marketplace/olx/categories?search=${encodeURIComponent(
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
        // fail-open
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [categorySearch, includeOlx, email]);

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Controller
          name="includeOlx"
          control={control}
          render={({ field }) => (
            <Switch
              id="pp-includeOlx"
              checked={field.value || false}
              onCheckedChange={field.onChange}
              disabled={olxAccounts.length === 0}
            />
          )}
        />
        <Label htmlFor="pp-includeOlx" className="cursor-pointer font-medium">
          Anunciar na OLX
        </Label>
      </div>

      {olxAccounts.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nenhuma conta da OLX selecionada na etapa Marketplaces.
        </p>
      )}

      {includeOlx && olxAccounts.length > 0 && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Contas da OLX</Label>
            <div className="space-y-2 rounded-md border p-3">
              {olxAccounts.map((acc) => (
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
                    {acc.accountName || "Conta OLX"}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Desmarque uma conta para não publicar este produto nela.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Categoria na OLX</Label>
            <Controller
              name="olxCategoryOverride"
              control={control}
              render={({ field }) => {
                const rawLabel =
                  watch("olxCategoryOverrideLabel") ||
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
                          placeholder="Buscar categoria da OLX..."
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
                                  setValue(
                                    "olxCategoryOverrideLabel",
                                    o.value,
                                    { shouldDirty: true },
                                  );
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
              Em branco, a categoria é resolvida automaticamente no envio.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
