"use client";

import { useCallback, useRef, useState } from "react";
import {
  Control,
  Controller,
  FieldErrors,
  UseFormSetValue,
  UseFormGetValues,
  useFieldArray,
} from "react-hook-form";
import { Plus, Search, Trash2, Loader2, Package } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getApiBaseUrl } from "@/lib/api";
import type { NfeDraftFormData } from "../../lib/nfe-form-schema";
import { EMPTY_NFE_ITEM, ORIGEM_LABELS } from "../../lib/nfe-defaults";
import type { ProductLookup } from "@/app/interfaces/nfe.interface";

interface Props {
  control: Control<NfeDraftFormData>;
  errors: FieldErrors<NfeDraftFormData>;
  setValue: UseFormSetValue<NfeDraftFormData>;
  getValues: UseFormGetValues<NfeDraftFormData>;
  email: string;
}

export function StepProdutos({
  control,
  errors,
  setValue,
  getValues,
  email,
}: Props) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: "itens",
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ProductLookup[]>([]);
  const [showResults, setShowResults] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchProducts = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setResults([]);
        return;
      }
      setSearching(true);
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/fiscal/lookup/products?q=${encodeURIComponent(q)}`,
          { headers: { email } },
        );
        if (res.ok) {
          const data = await res.json();
          setResults(data.results ?? []);
        }
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [email],
  );

  const handleSearchInput = (val: string) => {
    setSearchQuery(val);
    setShowResults(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => searchProducts(val), 400);
  };

  const addProductFromLookup = (p: ProductLookup) => {
    const nextNum = fields.length + 1;
    append({
      productId: p.id,
      numero: nextNum,
      codigo: p.sku,
      descricao: p.name,
      ncm: "",
      cfop: "5102",
      cest: null,
      origem: 0,
      unidade: "UN",
      quantidade: 1,
      valorUnitario: p.price,
      valorTotal: p.price,
      desconto: null,
      observacoes: null,
    });
    setShowResults(false);
    setSearchQuery("");
  };

  const addEmptyItem = () => {
    const nextNum = fields.length + 1;
    append({ ...EMPTY_NFE_ITEM, numero: nextNum });
  };

  const recalcItemTotal = (idx: number) => {
    const itens = getValues("itens");
    const item = itens[idx];
    if (!item) return;
    const qty = Number(item.quantidade) || 0;
    const unit = Number(item.valorUnitario) || 0;
    const desc = Number(item.desconto) || 0;
    const total = Math.max(0, qty * unit - desc);
    setValue(`itens.${idx}.valorTotal`, Math.round(total * 100) / 100);
  };

  const totalProdutos = fields.reduce((sum, _, idx) => {
    const itens = getValues("itens");
    return sum + (Number(itens[idx]?.valorTotal) || 0);
  }, 0);

  const itensErrors = errors.itens as any;

  return (
    <div className="space-y-6">
      {/* Product search */}
      <div className="relative">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Buscar produto do estoque
        </h3>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
              onFocus={() => results.length > 0 && setShowResults(true)}
              placeholder="Buscar por nome, SKU ou part number..."
              className="pl-9"
            />
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}

            {showResults && results.length > 0 && (
              <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-popover shadow-lg max-h-60 overflow-auto">
                {results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addProductFromLookup(p)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-accent/50 flex items-center gap-2"
                  >
                    <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-medium truncate">{p.name}</span>
                    <span className="text-muted-foreground text-xs ml-auto shrink-0">
                      {p.sku} | R$ {p.price.toFixed(2)} | Est: {p.stock}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button type="button" variant="outline" onClick={addEmptyItem}>
            <Plus className="h-4 w-4 mr-1" />
            Item manual
          </Button>
        </div>
      </div>

      {/* Items list */}
      {fields.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 p-8 text-center text-muted-foreground">
          <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Nenhum produto adicionado.</p>
          <p className="text-xs mt-1">
            Busque no estoque ou adicione um item manual.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {fields.map((field, idx) => (
            <div
              key={field.id}
              className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  Item {idx + 1}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(idx)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium">Código *</label>
                  <Controller
                    control={control}
                    name={`itens.${idx}.codigo`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="md:col-span-2 lg:col-span-3 space-y-1">
                  <label className="text-xs font-medium">Descrição *</label>
                  <Controller
                    control={control}
                    name={`itens.${idx}.descricao`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">NCM *</label>
                  <Controller
                    control={control}
                    name={`itens.${idx}.ncm`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="8 dígitos"
                        maxLength={8}
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">CFOP *</label>
                  <Controller
                    control={control}
                    name={`itens.${idx}.cfop`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="4 dígitos"
                        maxLength={4}
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Origem</label>
                  <Controller
                    control={control}
                    name={`itens.${idx}.origem`}
                    render={({ field }) => (
                      <Select
                        value={String(field.value ?? 0)}
                        onValueChange={(v) => field.onChange(Number(v))}
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(ORIGEM_LABELS).map(([k, v]) => (
                            <SelectItem key={k} value={k}>
                              {v}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Unidade *</label>
                  <Controller
                    control={control}
                    name={`itens.${idx}.unidade`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="UN, KG, CX..."
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Quantidade *</label>
                  <Controller
                    control={control}
                    name={`itens.${idx}.quantidade`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        step="0.0001"
                        min="0"
                        value={field.value ?? ""}
                        onChange={(e) => {
                          field.onChange(Number(e.target.value));
                          setTimeout(() => recalcItemTotal(idx), 0);
                        }}
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">
                    Valor unitário *
                  </label>
                  <Controller
                    control={control}
                    name={`itens.${idx}.valorUnitario`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        step="0.01"
                        min="0"
                        value={field.value ?? ""}
                        onChange={(e) => {
                          field.onChange(Number(e.target.value));
                          setTimeout(() => recalcItemTotal(idx), 0);
                        }}
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Desconto</label>
                  <Controller
                    control={control}
                    name={`itens.${idx}.desconto`}
                    render={({ field }) => (
                      <Input
                        {...field}
                        type="number"
                        step="0.01"
                        min="0"
                        value={field.value ?? ""}
                        onChange={(e) => {
                          field.onChange(
                            e.target.value ? Number(e.target.value) : null,
                          );
                          setTimeout(() => recalcItemTotal(idx), 0);
                        }}
                        className="h-8 text-sm"
                      />
                    )}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Valor total</label>
                  <Controller
                    control={control}
                    name={`itens.${idx}.valorTotal`}
                    render={({ field }) => (
                      <Input
                        value={`R$ ${(Number(field.value) || 0).toFixed(2)}`}
                        disabled
                        className="h-8 text-sm bg-muted/50"
                      />
                    )}
                  />
                </div>
              </div>
            </div>
          ))}

          {/* Total */}
          <div className="flex justify-end border-t border-border/60 pt-3">
            <div className="text-sm">
              <span className="text-muted-foreground">Total dos produtos: </span>
              <span className="font-semibold">
                R$ {totalProdutos.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      )}

      {itensErrors?.message && (
        <p className="text-xs text-destructive">{itensErrors.message}</p>
      )}
      {itensErrors?.root?.message && (
        <p className="text-xs text-destructive">{itensErrors.root.message}</p>
      )}
    </div>
  );
}
