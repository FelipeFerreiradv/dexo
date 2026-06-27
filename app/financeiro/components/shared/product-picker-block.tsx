"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Control, Controller, useFieldArray, useWatch } from "react-hook-form";
import {
  AlertTriangle,
  Car,
  Link2,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

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
  // Sucata de origem (aditivo) — pré-preenche o vínculo do item cadastrado.
  scrapId?: string | null;
  scrapLabel?: string | null;
}

export interface ProductMeta {
  sku: string;
  name: string;
  stock: number;
}

// Resultado da busca de sucata (GET /scraps?search=) — só o necessário p/ rótulo.
interface ScrapSearchResult {
  id: string;
  brand: string;
  model: string;
  year?: string | null;
  plate?: string | null;
}

// Rótulo legível de uma sucata. Mesmo formato do backend (lookup) p/
// consistência: "VW Gol · 2006 · ABC1D23".
export function scrapLabelFrom(s: {
  brand: string;
  model: string;
  year?: string | null;
  plate?: string | null;
}): string {
  return [`${s.brand} ${s.model}`.trim(), s.year || null, s.plate || null]
    .filter(Boolean)
    .join(" · ");
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
  // ScrapMeta (scrapId → rótulo legível). Mesmo motivo do productMeta: vive no
  // pai para sobreviver à navegação entre steps.
  scrapMeta: Record<string, string>;
  setScrapMeta: (
    updater: (m: Record<string, string>) => Record<string, string>,
  ) => void;
  // Rótulos parametrizáveis para reuso fora da venda balcão (ex.: Orçamento).
  // Os DEFAULTS preservam 100% o comportamento/texto da venda balcão.
  reasonPrefix?: string;
  headerTitle?: string;
  headerHint?: string;
}

export function ProductPickerBlock({
  control,
  setValue,
  getValues,
  productMeta,
  setProductMeta,
  scrapMeta,
  setScrapMeta,
  reasonPrefix = "Venda balcão — ",
  headerTitle = "Produtos (venda balcão)",
  headerHint = "Itens deste título. O estoque será baixado na finalização (pagamento).",
}: Props) {
  const { data: session } = useSession();
  // Sucata "da venda" (default no cabeçalho): só pré-preenche NOVAS linhas
  // manuais/cadastradas sem sucata própria. Não altera linhas já adicionadas.
  const [accountScrapId, setAccountScrapId] = useState<string | null>(null);
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

    // Sucata efetiva: a de origem do produto (Product.scrapId) tem prioridade;
    // senão, o default da venda (cabeçalho). Editável por linha depois.
    const scrapId = p.scrapId ?? accountScrapId ?? null;

    // Adiciona com qty=1 e preço corrente (snapshot ao salvar).
    append({
      productId: p.id,
      description: null,
      scrapId,
      listingId: null,
      quantity: 1,
      unitPrice: p.price,
    } as any);

    setProductMeta((m: Record<string, ProductMeta>) => ({
      ...m,
      [p.id]: { sku: p.sku, name: p.name, stock: p.stock },
    }));

    // Registra o rótulo da sucata de origem do produto (o default da venda já
    // está no scrapMeta quando foi escolhido no cabeçalho).
    if (p.scrapId && p.scrapLabel) {
      const sid = p.scrapId;
      const slabel = p.scrapLabel;
      setScrapMeta((m) => ({ ...m, [sid]: slabel }));
    }

    // Pré-preenche totalAmount com o NOVO subtotal (existente + 1×preço).
    const prevSubtotal = computeSubtotal(items);
    const newSubtotal = prevSubtotal + (Number(p.price) || 0);
    setValue("totalAmount", newSubtotal, { shouldDirty: true });

    // O "título" (reason) é gerenciado reativamente pelo efeito abaixo
    // (reflete o 1º item + "e mais N"), não mais aqui.

    setOpen(false);
    setQuery("");
  };

  // Adiciona uma linha de item MANUAL (texto livre, sem produto cadastrado).
  // productId null sinaliza item manual; description é o texto livre. Não mexe
  // em totalAmount (preço começa 0 — o usuário digita; pode sincronizar via
  // "Usar no total").
  const handleAddManual = (initialDescription = "") => {
    append({
      productId: null,
      description: initialDescription,
      // Default da venda (cabeçalho) pré-preenche a linha manual; editável.
      scrapId: accountScrapId ?? null,
      listingId: null,
      quantity: 1,
      unitPrice: 0,
    } as any);
    // O "título" (reason) é gerenciado reativamente pelo efeito abaixo.
  };

  // ── Título (reason) reativo ──
  // Enquanto o usuário NÃO editar o Motivo manualmente, o título acompanha os
  // itens: "Venda balcão — <1º item>" + "e mais N" quando há mais de um. Assim
  // a listagem (Documento = document || reason) nunca fica vazia, inclusive em
  // vendas só com itens manuais. Para o produto, usa o nome (productMeta); para
  // o manual, a descrição digitada (atualiza conforme o usuário digita).
  const watchedItems = useWatch({ control, name: "items" });
  const autoReasonRef = useRef<string | null>(null);
  useEffect(() => {
    const items = (watchedItems as any[]) ?? [];
    const current = (getValues().reason ?? "").trim();
    // Só gerencia se o Motivo está vazio OU é exatamente o último auto-gerado
    // (ou seja, o usuário não digitou um Motivo próprio).
    const owns = current === "" || current === (autoReasonRef.current ?? "");
    if (!owns) return;

    if (items.length === 0) {
      if (autoReasonRef.current && current === autoReasonRef.current) {
        setValue("reason", "", { shouldDirty: true });
        autoReasonRef.current = "";
      }
      return;
    }

    const first = items[0];
    const firstLabel = first?.productId
      ? (productMeta[first.productId as string]?.name ?? "Produto")
      : ((first?.description ?? "").trim() || "Item avulso");
    const extra = items.length - 1;
    const suffix =
      extra > 0 ? ` e mais ${extra} ${extra === 1 ? "item" : "itens"}` : "";
    const title = `${reasonPrefix}${firstLabel}${suffix}`;

    if (title !== current) {
      setValue("reason", title, { shouldDirty: true });
      autoReasonRef.current = title;
    }
  }, [watchedItems, productMeta, getValues, setValue, reasonPrefix]);

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{headerTitle}</p>
          <p className="text-xs text-muted-foreground">{headerHint}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handleAddManual()}
          >
            <Plus className="size-4" />
            Item manual
          </Button>
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
              {/* Atalho: não encontrou? adiciona o texto digitado como item manual. */}
              {debounced.length >= 2 && (
                <button
                  type="button"
                  onClick={() => {
                    handleAddManual(query.trim());
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <Plus className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">
                    Adicionar{" "}
                    <span className="font-medium">
                      &ldquo;{query.trim()}&rdquo;
                    </span>{" "}
                    manualmente
                  </span>
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Sucata da venda (default no cabeçalho) — pré-preenche novas linhas. */}
      <div className="flex flex-col gap-1.5 rounded-md border border-border/50 bg-background/40 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium">Sucata da venda (opcional)</p>
          <p className="text-[11px] text-muted-foreground">
            Pré-preenche o vínculo de novas linhas; não altera as já
            adicionadas.
          </p>
        </div>
        <ScrapCombobox
          session={session}
          valueLabel={
            accountScrapId ? (scrapMeta[accountScrapId] ?? "Sucata") : null
          }
          onSelect={(id, label) => {
            setAccountScrapId(id);
            setScrapMeta((m) => ({ ...m, [id]: label }));
          }}
          onClear={() => setAccountScrapId(null)}
          placeholder="Vincular sucata"
        />
      </div>

      {fields.length === 0 && (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
          Nenhum item adicionado. Use "Adicionar produto" (catálogo) ou "Item
          manual" (texto livre).
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
              session={session}
              scrapMeta={scrapMeta}
              setScrapMeta={setScrapMeta}
            />
          ))}
          <ItemSubtotalLine getValues={getValues} setValue={setValue} />
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
  setValue,
}: {
  getValues: () => FinanceEntryFormData;
  setValue: (name: any, value: any, options?: any) => void;
}) {
  // Recalcula a cada render do bloco — ok pois é tela pequena. Para evitar
  // staleness em digitação, lemos via getValues no momento do render.
  const subtotal = computeSubtotal(getValues().items as any[]);
  return (
    <div className="flex items-center justify-end gap-2 px-1 pt-1 text-xs text-muted-foreground">
      <span>Subtotal dos itens:</span>
      <span className="font-medium text-foreground">
        R$ {formatToBRL(subtotal)}
      </span>
      {/* Sincroniza o Valor total (editável) com o subtotal — útil em vendas
          com itens manuais, cujo preço o usuário digita após adicionar. */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[11px]"
        onClick={() => setValue("totalAmount", subtotal, { shouldDirty: true })}
      >
        Usar no total
      </Button>
    </div>
  );
}

interface ItemRowProps {
  index: number;
  control: Control<FinanceEntryFormData>;
  meta: ProductMeta | undefined;
  productId?: string | null;
  getValues: () => FinanceEntryFormData;
  onRemove: () => void;
  session: ReturnType<typeof useSession>["data"];
  scrapMeta: Record<string, string>;
  setScrapMeta: (
    updater: (m: Record<string, string>) => Record<string, string>,
  ) => void;
}

function ItemRow({
  index,
  control,
  meta,
  productId,
  getValues,
  onRemove,
  session,
  scrapMeta,
  setScrapMeta,
}: ItemRowProps) {
  // Item manual (sem produto cadastrado): productId nulo/ausente. Renderiza
  // um input de descrição livre em vez do card de produto.
  const isManual = !productId;
  return (
    <div className="space-y-1.5 rounded-md border border-transparent">
      <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-12">
      <div className="col-span-2 sm:col-span-7">
        {isManual ? (
          <Controller
            control={control}
            name={`items.${index}.description` as const}
            render={({ field }) => (
              <Input
                value={(field.value as string) ?? ""}
                onChange={field.onChange}
                placeholder="Descrição do item (texto livre)"
                aria-label="Descrição do item manual"
                className="h-9"
              />
            )}
          />
        ) : (
          /* Card produto: altura adaptável; nome pode quebrar em até 2 linhas
             (line-clamp-2). SKU em fonte menor abaixo. Reservado para nomes
             longos comuns em autopeças. */
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
        )}
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

      {/* Vínculo de sucata por item (cadastrado ou manual). Pré-preenchido por
          Product.scrapId no item cadastrado; editável/removível. */}
      <div className="flex items-center gap-2 pl-1">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          Sucata
        </span>
        <Controller
          control={control}
          name={`items.${index}.scrapId` as const}
          render={({ field }) => (
            <ScrapCombobox
              session={session}
              valueLabel={
                field.value
                  ? (scrapMeta[field.value as string] ?? "Sucata vinculada")
                  : null
              }
              onSelect={(id, label) => {
                field.onChange(id);
                setScrapMeta((m) => ({ ...m, [id]: label }));
              }}
              onClear={() => field.onChange(null)}
              placeholder="Vincular sucata (opcional)"
              compact
            />
          )}
        />
      </div>
    </div>
  );
}

// Combobox de SUCATA (reusa GET /scraps?search=). Usado no cabeçalho (default
// da venda) e por item. Debounce 250ms + abort, mesmo padrão da busca de produto.
function ScrapCombobox({
  session,
  valueLabel,
  onSelect,
  onClear,
  placeholder = "Vincular sucata",
  compact,
}: {
  session: ReturnType<typeof useSession>["data"];
  valueLabel: string | null;
  onSelect: (id: string, label: string) => void;
  onClear: () => void;
  placeholder?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<ScrapSearchResult[]>([]);
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
      const url = `${getApiBaseUrl()}/scraps?search=${encodeURIComponent(
        debounced,
      )}&limit=10`;
      const res = await fetch(url, { headers: { email }, signal: ctrl.signal });
      if (!res.ok) throw new Error("scrap search failed");
      const data = await res.json();
      setOptions(Array.isArray(data?.scraps) ? data.scraps : []);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setOptions([]);
    } finally {
      setLoading(false);
    }
  }, [session?.user?.email, debounced]);

  useEffect(() => {
    if (open) search();
  }, [open, search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "h-7 max-w-full justify-start gap-1.5 text-xs font-normal",
            compact && "min-w-0",
          )}
        >
          {valueLabel ? (
            <Car className="size-3.5 shrink-0 text-primary" />
          ) : (
            <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className={cn("truncate", !valueLabel && "text-muted-foreground")}>
            {valueLabel ?? placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="relative border-b border-border/60 p-2">
          <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar sucata (marca, modelo, placa)..."
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
                : "Nenhuma sucata encontrada."}
            </p>
          )}
          {options.map((o) => {
            const label = scrapLabelFrom(o);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onSelect(o.id, label);
                  setOpen(false);
                  setQuery("");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <Car className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
        {valueLabel && (
          <button
            type="button"
            onClick={() => {
              onClear();
              setOpen(false);
              setQuery("");
            }}
            className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2 text-left text-sm text-destructive hover:bg-muted"
          >
            <X className="size-4 shrink-0" />
            Remover vínculo
          </button>
        )}
      </PopoverContent>
    </Popover>
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
