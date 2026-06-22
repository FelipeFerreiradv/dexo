"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Database, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getApiBaseUrl } from "@/lib/api";
import type { InternalSuggestion } from "../lib/apply-internal-suggestion";

interface InternalSuggestionPickerProps {
  /** Título atual do produto — dispara a busca quando muda (com debounce). */
  title: string;
  /** Chamado quando o usuário clica em "Usar sugestão". */
  onAccept: (suggestion: InternalSuggestion) => void;
  /** Desliga tudo (ex.: formulário submetendo). */
  disabled?: boolean;
  /** Email do usuário logado — header usado pelo authMiddleware do backend. */
  email?: string | null;
}

const DEBOUNCE_MS = 400;
const MIN_CHARS = 5;

const CONFIDENCE_LABEL: Record<string, string> = {
  alta: "alta confiança",
  media: "confiança média",
  baixa: "baixa confiança",
};

function suggestUrl(title: string): string {
  const params = new URLSearchParams({ title });
  return `${getApiBaseUrl()}/marketplace/internal/suggest?${params.toString()}`;
}

function formatBRL(n: number): string {
  try {
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  } catch {
    return `R$ ${n.toFixed(2)}`;
  }
}

/** Lista curta e legível dos campos que serão preenchidos. */
function fieldChips(s: InternalSuggestion): string[] {
  const f = s.fields;
  const chips: string[] = [];
  if (f.priceMedian != null)
    chips.push(`Preço ref.: ${formatBRL(f.priceMedian)}`);
  if (f.quality) chips.push(`Qualidade: ${f.quality}`);
  if (f.brand || f.model)
    chips.push(`Veículo: ${[f.brand, f.model].filter(Boolean).join(" ")}`);
  if (f.sourceVehicle) chips.push(`Origem: ${f.sourceVehicle}`);
  if (f.partNumber) chips.push(`Part number: ${f.partNumber}`);
  if (f.weightKg != null) chips.push(`Peso: ${f.weightKg} kg`);
  if (f.heightCm != null || f.widthCm != null || f.lengthCm != null)
    chips.push(
      `Medidas: ${f.heightCm ?? "?"}×${f.widthCm ?? "?"}×${f.lengthCm ?? "?"} cm`,
    );
  if (s.compatibilities && s.compatibilities.length > 0)
    chips.push(`${s.compatibilities.length} compatibilidade(s)`);
  if (s.attributes && Object.keys(s.attributes).length > 0)
    chips.push(`${Object.keys(s.attributes).length} item(ns) de ficha técnica`);
  return chips;
}

export function InternalSuggestionPicker({
  title,
  onAccept,
  disabled,
  email,
}: InternalSuggestionPickerProps) {
  const [suggestion, setSuggestion] = useState<InternalSuggestion | null>(null);
  const [noSample, setNoSample] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = (title ?? "").trim();
    if (q.length < MIN_CHARS) {
      setSuggestion(null);
      setNoSample(false);
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

      fetch(suggestUrl(q), {
        credentials: "include",
        headers: email ? { email } : {},
        signal: ctrl.signal,
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json();
          if (data?.suggestion) {
            setSuggestion(data.suggestion as InternalSuggestion);
            setNoSample(false);
          } else {
            setSuggestion(null);
            setNoSample(true);
          }
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          setSuggestion(null);
          setNoSample(false);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [title, email]);

  useEffect(
    () => () => {
      if (abortRef.current) abortRef.current.abort();
    },
    [],
  );

  const q = (title ?? "").trim();
  if (q.length < MIN_CHARS) return null;

  return (
    <div className="rounded-md border border-dashed border-amber-500/50 bg-amber-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <Database className="w-4 h-4" />
        Sugestão da base interna
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" />}
      </div>

      {error && (
        <p className="text-xs text-destructive">
          Não foi possível consultar a base: {error}
        </p>
      )}

      {!loading && !error && noSample && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          Sem dados suficientes na base para sugerir (mínimo de 5 cadastros
          semelhantes).
        </p>
      )}

      {suggestion && !loading && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              Baseado em {suggestion.sampleSize ?? 0} produto(s)
            </span>
            {suggestion.confidence && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-400">
                {CONFIDENCE_LABEL[suggestion.confidence] ??
                  suggestion.confidence}
              </span>
            )}
          </div>

          <ul className="flex flex-wrap gap-1.5">
            {fieldChips(suggestion).map((c, i) => (
              <li
                key={i}
                className="rounded border bg-background px-2 py-0.5 text-xs text-muted-foreground"
              >
                {c}
              </li>
            ))}
          </ul>

          <p className="text-[11px] text-muted-foreground">
            Preenche só os campos vazios — você pode editar tudo depois. O preço
            é uma referência (mediana dos cadastros).
          </p>

          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => onAccept(suggestion)}
          >
            Usar sugestão
          </Button>
        </div>
      )}
    </div>
  );
}
