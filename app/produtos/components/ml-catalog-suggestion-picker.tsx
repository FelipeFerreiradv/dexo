"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, ExternalLink, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getApiBaseUrl } from "@/lib/api";
import type {
  CatalogSuggestion,
  CatalogProductDetail,
} from "../../marketplaces/usecases/ml-catalog-suggestion.usecase";

interface MLCatalogSuggestionPickerProps {
  /** Título atual do produto — dispara busca quando muda (com debounce). */
  title: string;
  /** Chamado quando o usuário confirma uma sugestão — recebe detalhes normalizados. */
  onAccept: (detail: CatalogProductDetail) => void;
  /** catalogProductId já vinculado ao form, se houver — exibido como "selecionado". */
  selectedId?: string | null;
  /** Desliga tudo (ex.: formulário submetendo). */
  disabled?: boolean;
  /** Opcional: limita a sugestão a uma categoria já escolhida pelo usuário. */
  categoryIdFilter?: string | null;
  /** Email do usuário logado — usado como header pelo authMiddleware do backend. */
  email?: string | null;
}

const DEBOUNCE_MS = 400;
const MIN_CHARS = 5;
const SUGGESTION_LIMIT = 5;

function buildFetchUrl(q: string, categoryId?: string | null): string {
  const base = getApiBaseUrl();
  const params = new URLSearchParams({
    q,
    limit: String(SUGGESTION_LIMIT),
  });
  if (categoryId) params.set("category_id", categoryId);
  return `${base}/marketplace/ml/catalog/suggestions?${params.toString()}`;
}

function buildDetailUrl(catalogProductId: string): string {
  return `${getApiBaseUrl()}/marketplace/ml/catalog/products/${encodeURIComponent(
    catalogProductId,
  )}`;
}

export function MLCatalogSuggestionPicker({
  title,
  onAccept,
  selectedId,
  disabled,
  categoryIdFilter,
  email,
}: MLCatalogSuggestionPickerProps) {
  const [suggestions, setSuggestions] = useState<CatalogSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = (title ?? "").trim();
    if (q.length < MIN_CHARS) {
      setSuggestions([]);
      setError(null);
      setLoading(false);
      if (abortRef.current) abortRef.current.abort();
      return;
    }

    const timer = setTimeout(() => {
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);

      fetch(buildFetchUrl(q, categoryIdFilter), {
        credentials: "include",
        headers: email ? { email } : {},
        signal: ctrl.signal,
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json();
          const list = Array.isArray(data?.suggestions) ? data.suggestions : [];
          setSuggestions(list as CatalogSuggestion[]);
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          setSuggestions([]);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [title, categoryIdFilter]);

  useEffect(
    () => () => {
      if (abortRef.current) abortRef.current.abort();
    },
    [],
  );

  const handleSelect = async (catalogProductId: string) => {
    if (disabled) return;
    setLoadingDetailId(catalogProductId);
    setError(null);
    try {
      const resp = await fetch(buildDetailUrl(catalogProductId), {
        credentials: "include",
        headers: email ? { email } : {},
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const product = data?.product as CatalogProductDetail | undefined;
      if (!product?.catalogProductId) {
        throw new Error("Resposta inválida do catálogo");
      }
      onAccept(product);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Não foi possível carregar o catálogo escolhido",
      );
    } finally {
      setLoadingDetailId(null);
    }
  };

  const q = (title ?? "").trim();
  if (q.length < MIN_CHARS) return null;

  return (
    <div className="rounded-md border border-dashed border-primary/40 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <Sparkles className="w-4 h-4" />
        Sugestões do catálogo Mercado Livre
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" />}
      </div>

      {error && (
        <p className="text-xs text-destructive">
          Não foi possível carregar sugestões: {error}
        </p>
      )}

      {!loading && !error && suggestions.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nenhuma sugestão encontrada para este título.
        </p>
      )}

      {suggestions.length > 0 && (
        <ul className="space-y-2">
          {suggestions.map((s) => {
            const isSelected = selectedId === s.catalogProductId;
            const isLoadingThis = loadingDetailId === s.catalogProductId;
            return (
              <li
                key={s.catalogProductId}
                className="flex items-center gap-3 rounded-md border bg-background p-2"
              >
                {s.thumbnailUrl ? (
                  <img
                    src={s.thumbnailUrl}
                    alt=""
                    className="w-12 h-12 rounded object-cover bg-muted"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-12 h-12 rounded bg-muted" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" title={s.name}>
                    {s.name}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {[s.brand, s.model].filter(Boolean).join(" ") ||
                      s.catalogProductId}
                    {s.categoryId ? ` • ${s.categoryId}` : ""}
                  </p>
                </div>
                {s.permalink && (
                  <a
                    href={s.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
                    title="Abrir no Mercado Livre"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={isSelected ? "secondary" : "default"}
                  disabled={disabled || isLoadingThis}
                  onClick={() => handleSelect(s.catalogProductId)}
                >
                  {isLoadingThis ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : isSelected ? (
                    <>
                      <Check className="w-3.5 h-3.5 mr-1" /> Selecionado
                    </>
                  ) : (
                    "Usar este catálogo"
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
