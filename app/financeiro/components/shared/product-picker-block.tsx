"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Control, Controller, useFieldArray } from "react-hook-form";
import { AlertTriangle, Loader2, Plus, Search, Trash2 } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrencyInput, formatToBRL } from "@/components/ui/currency-input";
import { getApiBaseUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

import type { FinanceEntryFormData } from "../../lib/finance-schema";

// ──────────────────────────────────────────────────────────
// Fase 5 — bloco de seleção de produto para venda balcão.
// Renderiza no topo do step "Título" do FinanceDialog quando o flag
// NEXT_PUBLIC_BALCAO_SALE_ENABLED estiver ligado. Sem o flag, o step
// renderiza exatamente como antes (zero mudança visual/funcional).
//
// Comportamento:
//  - Busca produto por SKU/nome via GET /finance/products/lookup (debounce
//    250ms, abort em mudança rápida — mesmo padrão de customer-combobox).
//  - Append no useFieldArray("items") com qty=1, unitPrice=product.price
//    (snapshot ao salvar — Decimal(10,2)).
//  - Ao ADICIONAR o primeiro produto: pré-preenche `totalAmount` com o
//    subtotal e `reason` (se vazio) com "Venda balcão — <SKU> <nome>".
//  - Alterações subsequentes (qty/preço/remover) NÃO sobrescrevem o
//    totalAmount (continua editável). Mostramos o subtotal como info ao
//    lado da lista para o usuário decidir sincronizar manualmente.
//  - Alerta visual "qty > estoque" — não bloqueia salvar (no caso de
//    pré-venda; oversell é monitorado depois pelo SystemLog).
// ──────────────────────────────────────────────────────────

export interface ProductLookupResult {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
}

export interface ProductMeta {
  sku: string;
  name: string;
  stock: number;
}

interface Props {
  control: Control<FinanceEntryFormData>;
  setValue: (name: any, value: any, options?: any) => void;
  getValues: () => FinanceEntryFormData;
  // ProductMetaMap é gerenciado pelo FinanceDialog (pai) para sobreviver à
  // navegação entre steps — TitleStep desmonta ao mudar de step e remontaria
  // o estado local. Bloco lê e atualiza via setProductMeta.
  productMeta: Record<string, ProductMeta>;
  setProductMeta: (
    updater: (m: Record<string, ProductMeta>) => Record<string, ProductMeta>,
  ) => void;
}

export function ProductPickerBlock({
  control,
  setValue,
  getValues,
  productMeta,
  setProductMeta,
}: Props) {
  const { data: session } = useSession();
  const { fields, append, remove } = useFieldArray({
    control,
    name: "items",
  });

  // ── Combobox (mesmo padrão do customer-combobox).
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<ProductLookupResult[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const search = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    if (debounced.length < 2) {
      setOptions([]);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const url = `${getApiBaseUrl()}/finance/products/lookup?q=${encodeURIComponent(
        debounced,
      )}`;
      const res = await fetch(url, {
        headers: { email },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error("lookup failed");
      const data = await res.json();
      setOptions(data.results || []);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setOptions([]);
    } finally {
      setLoading(false);
    }
  }, [session?.user?.email, debounced]);

  useEffect(() => {
    if (open) search();
  }, [open, search]);

  const handlePick = (p: ProductLookupResult) => {
    const items = getValues().items ?? [];

    // Produto já adicionado → só fecha o popover (usuário ajusta a linha).
    if (items.some((it: any) => it?.productId === p.id)) {
      setOpen(false);
      setQuery("");
      return;
    }

    // Adiciona com qty=1 e preço corrente (snapshot ao salvar).
    append({
      productId: p.id,
      listingId: null,
      quantity: 1,
      unitPrice: p.price,
    } as any);

    setProductMeta((m: Record<string, ProductMeta>) => ({
      ...m,
      [p.id]: { sku: p.sku, name: p.name, stock: p.stock },
    }));

    // Pré-preenche totalAmount com o NOVO subtotal (existente + 1×preço).
    const prevSubtotal = computeSubtotal(items);
    const newSubtotal = prevSubtotal + (Number(p.price) || 0);
    setValue("totalAmount", newSubtotal, { shouldDirty: true });

    // Pré-preenche reason apenas se ainda estiver vazio (não sobrescreve).
    const current = getValues();
    if (!current.reason || !current.reason.trim()) {
      const label = `Venda balcão — ${p.sku} ${p.name}`.trim();
      setValue("reason", label, { shouldDirty: true });
    }

    setOpen(false);
    setQuery("");
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Produtos (venda balcão)</p>
          <p className="text-xs text-muted-foreground">
            Itens deste título. O estoque será baixado na finalização
            (pagamento).
          </p>
        </div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <Plus className="size-4" />
              Adicionar produto
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="relative border-b border-border/60 p-2">
              <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por SKU ou nome..."
                className="h-9 pl-8"
              />
              {loading && (
                <Loader2 className="absolute right-4 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {options.length === 0 && !loading && (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {debounced.length < 2
                    ? "Digite ao menos 2 caracteres..."
                    : "Nenhum produto encontrado."}
                </p>
              )}
              {options.map((opt) => (
                <button
                  type="button"
                  key={opt.id}
                  onClick={() => handlePick(opt)}
                  className={cn(
                    "flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted",
                  )}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{opt.name}</span>
                    <span className="text-xs text-muted-foreground">
                      SKU: {opt.sku} · Estoque: {opt.stock}
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    R$ {formatToBRL(Number(opt.price))}
                  </span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {fields.length === 0 && (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
          Nenhum produto adicionado. Use "Adicionar produto" para selecionar.
        </p>
      )}

      {fields.length > 0 && (
        <div className="space-y-2">
          <div className="hidden grid-cols-12 gap-3 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
            <div className="col-span-2 sm:col-span-7">Produto</div>
            <div className="col-span-1 sm:col-span-2">Qtd</div>
            <div className="col-span-1 sm:col-span-2">Preço un.</div>
            <div className="col-span-1" />
          </div>
          {fields.map((field, idx) => (
            <ItemRow
              key={field.id}
              index={idx}
              control={control}
              meta={productMeta[(field as any).productId]}
              productId={(field as any).productId}
              getValues={getValues}
              onRemove={() => remove(idx)}
            />
          ))}
          <ItemSubtotalLine getValues={getValues} />
        </div>
      )}
    </div>
  );
}

// Soma qty × unitPrice. Tolerante a undefined/NaN.
function computeSubtotal(items: any[] | undefined | null): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, it) => {
    const q = Number(it?.quantity) || 0;
    const p = Number(it?.unitPrice) || 0;
    return sum + q * p;
  }, 0);
}

function ItemSubtotalLine({
  getValues,
}: {
  getValues: () => FinanceEntryFormData;
}) {
  // Recalcula a cada render do bloco — ok pois é tela pequena. Para evitar
  // staleness em digitação, lemos via getValues no momento do render.
  const subtotal = computeSubtotal(getValues().items as any[]);
  return (
    <div className="flex justify-end px-1 pt-1 text-xs text-muted-foreground">
      Subtotal dos itens:
      <span className="ml-2 font-medium text-foreground">
        R$ {formatToBRL(subtotal)}
      </span>
    </div>
  );
}

interface ItemRowProps {
  index: number;
  control: Control<FinanceEntryFormData>;
  meta: ProductMeta | undefined;
  productId: string;
  getValues: () => FinanceEntryFormData;
  onRemove: () => void;
}

function ItemRow({
  index,
  control,
  meta,
  productId,
  getValues,
  onRemove,
}: ItemRowProps) {
  return (
    <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-12">
      <div className="col-span-2 sm:col-span-7">
        {/* Card produto: altura adaptável; nome pode quebrar em até 2 linhas
            (line-clamp-2). SKU em fonte menor abaixo. Reservado para nomes
            longos comuns em autopeças. */}
        <div className="flex min-h-9 w-full items-start rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 text-sm">
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="font-medium line-clamp-2 break-words">
              {meta?.name ?? "Produto"}
            </span>
            <span className="truncate text-[10px] text-muted-foreground">
              SKU: {meta?.sku ?? productId}
            </span>
          </span>
        </div>
      </div>
      <div className="col-span-1 sm:col-span-2">
        <Controller
          control={control}
          name={`items.${index}.quantity` as const}
          render={({ field }) => (
            <QuantityInput
              value={Number(field.value ?? 1)}
              onChange={field.onChange}
              stock={meta?.stock}
            />
          )}
        />
      </div>
      <div className="col-span-1 sm:col-span-2">
        <Controller
          control={control}
          name={`items.${index}.unitPrice` as const}
          render={({ field }) => (
            <CurrencyInput
              value={Number(field.value ?? 0)}
              onChange={(v) => field.onChange(v ?? 0)}
            />
          )}
        />
      </div>
      <div className="col-span-2 flex justify-end sm:col-span-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label="Remover item"
          className="h-9 w-9"
        >
          <Trash2 className="size-4 text-destructive" />
        </Button>
      </div>
    </div>
  );
}

function QuantityInput({
  value,
  onChange,
  stock,
}: {
  value: number;
  onChange: (v: number) => void;
  stock: number | undefined;
}) {
  const overStock =
    typeof stock === "number" && stock > 0 && value > stock;
  return (
    <div className="relative">
      <Input
        type="number"
        min={1}
        step={1}
        value={String(value || 1)}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          onChange(Number.isFinite(v) && v > 0 ? v : 1);
        }}
        className={cn("h-9", overStock && "border-amber-500")}
        aria-invalid={overStock || undefined}
      />
      {overStock && (
        <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-600">
          <AlertTriangle className="size-3" />
          Excede estoque ({stock})
        </p>
      )}
    </div>
  );
}
