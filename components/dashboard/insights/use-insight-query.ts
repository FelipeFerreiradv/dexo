"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";

import { getApiBaseUrl, authHeaders } from "@/lib/api";
import {
  resolveSelectedRange,
  type ReportPresetId,
} from "@/lib/report-period";

/**
 * Estado de período + fetch de um card de insight do Dashboard.
 *
 * Cada card tem o SEU período, então cada um tem a sua instância deste hook —
 * é o que dá os "filtros independentes" sem re-renderizar a página inteira.
 * O fetch é client-side de propósito: `app/page.tsx` é Server Component e puxar
 * isso para o `Promise.all` dele colocaria 4 chamadas no caminho crítico de um
 * SSR que não tem loading.tsx nem error.tsx.
 */
export interface InsightQueryState<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  /** true no modo personalizado enquanto faltar uma das datas. */
  incomplete: boolean;
  preset: ReportPresetId;
  setPreset: (p: ReportPresetId) => void;
  customStart: string;
  setCustomStart: (v: string) => void;
  customEnd: string;
  setCustomEnd: (v: string) => void;
  reload: () => void;
}

export function useInsightQuery<T>(
  path: string,
  params?: Record<string, string | undefined>,
  initialPreset: ReportPresetId = "30d",
): InsightQueryState<T> {
  const { data: session } = useSession();
  const email = session?.user?.email ?? null;

  const [preset, setPreset] = useState<ReportPresetId>(initialPreset);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const range = resolveSelectedRange(preset, customStart, customEnd);
  const incomplete = range === null;

  // `range` é um objeto NOVO a cada render; as deps precisam ser as strings,
  // senão o useMemo recalcula à toa. Extraídas antes para o exhaustive-deps
  // conseguir enxergá-las.
  const rangeStart = range?.start;
  const rangeEnd = range?.end;

  // Um objeto literal vindo do card também muda de identidade a cada render; a
  // chave serializada é o que impede o useEffect de virar loop infinito.
  const paramsKey = JSON.stringify(params ?? {});

  const query = useMemo(() => {
    const search = new URLSearchParams();
    if (rangeStart && rangeEnd) {
      search.set("startDate", rangeStart);
      search.set("endDate", rangeEnd);
    }
    for (const [k, v] of Object.entries(
      JSON.parse(paramsKey) as Record<string, string | undefined>,
    )) {
      if (v) search.set(k, v);
    }
    return search.toString();
  }, [rangeStart, rangeEnd, paramsKey]);

  const fetchData = useCallback(async () => {
    if (!email) return;
    // No modo personalizado, espera as duas datas para não disparar incompleto.
    if (incomplete) return;

    // EGRESS + correção: trocar o período algumas vezes seguidas dispara uma
    // busca por troca. Sem cancelar a anterior, (a) todas continuam baixando
    // resposta que ninguém vai usar e (b) a mais LENTA pode chegar por último e
    // sobrescrever a mais recente, mostrando o período errado no gráfico.
    // Mesmo padrão de app/financeiro/components/finance-overview.tsx:45-47.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`${getApiBaseUrl()}${path}?${query}`, {
        headers: authHeaders(session),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // 403 = colaborador sem acesso ao Dashboard. Não é falha do card:
        // some silenciosamente em vez de acusar erro.
        if (res.status === 403) {
          setData(null);
          return;
        }
        throw new Error(`Erro ${res.status}`);
      }
      setData((await res.json()) as T);
    } catch (err) {
      // Cancelada por uma busca mais nova: não é erro e não deve piscar a UI.
      if (ctrl.signal.aborted) return;
      console.error(`[insight] ${path}`, err);
      setError(true);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
    // `session` fora das deps de propósito: muda de identidade a cada refresh
    // do next-auth e refaria o fetch sem necessidade. O que importa é o email.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, path, query, incomplete, nonce]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    data,
    loading,
    error,
    incomplete,
    preset,
    setPreset,
    customStart,
    setCustomStart,
    customEnd,
    setCustomEnd,
    reload,
  };
}
