"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBaseUrl } from "@/lib/api";

export type BulkJobStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED_PARTIAL"
  | "FAILED";

export interface BulkJobResultItem {
  productId: string;
  platform: "MERCADO_LIVRE" | "SHOPEE" | "MAGALU" | "OLX" | "FACEBOOK";
  accountId: string;
  success: boolean;
  listingId?: string;
  externalListingId?: string;
  error?: string;
  finishedAt?: string;
}

export interface BulkJobSnapshot {
  id: string;
  status: BulkJobStatus;
  totalItems: number;
  doneItems: number;
  successItems: number;
  failedItems: number;
  results: BulkJobResultItem[];
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Intervalo de polling adaptativo:
//  - "fast" (750ms) quando o job acabou de mudar (resposta perceptivelmente
//    instantânea para o usuário enquanto resultados estão chegando).
//  - "slow" (1500ms) após 2 ticks consecutivos sem mudança (alivia carga
//    no servidor quando o job está realmente parado/inerte).
const POLL_FAST_MS = 750;
const POLL_SLOW_MS = 1500;
const TERMINAL: BulkJobStatus[] = ["COMPLETED", "FAILED_PARTIAL", "FAILED"];

/**
 * Hook que faz polling em GET /listings/bulk/:jobId enquanto o job não está
 * em status terminal. Para o polling automaticamente ao concluir.
 *
 * Uso:
 *   const { snapshot, error, isPolling } = useBulkListingJob(jobId, email);
 */
export function useBulkListingJob(
  jobId: string | null,
  email: string | undefined,
) {
  const [snapshot, setSnapshot] = useState<BulkJobSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  const fetchOnce = useCallback(async () => {
    if (!jobId || !email) return null;
    try {
      const res = await fetch(`${getApiBaseUrl()}/listings/bulk/${jobId}`, {
        headers: { email },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data?.message as string) ||
            (data?.error as string) ||
            `HTTP ${res.status}`,
        );
      }
      const data = (await res.json()) as BulkJobSnapshot;
      const normalized: BulkJobSnapshot = {
        ...data,
        results: Array.isArray(data.results) ? data.results : [],
      };
      setSnapshot(normalized);
      setError(null);
      return normalized;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao consultar job");
      return null;
    }
  }, [jobId, email]);

  useEffect(() => {
    cancelled.current = false;
    if (!jobId || !email) {
      setSnapshot(null);
      setError(null);
      setIsPolling(false);
      return () => {};
    }

    setIsPolling(true);

    let lastDone = -1;
    let stagnantTicks = 0;

    const tick = async () => {
      if (cancelled.current) return;
      const snap = await fetchOnce();
      if (cancelled.current) return;
      if (snap && TERMINAL.includes(snap.status)) {
        setIsPolling(false);
        return;
      }

      // Adaptativo: se houve progresso desde o último tick, polla rápido;
      // após 2 ticks parados, vai para o intervalo lento.
      if (snap && snap.doneItems !== lastDone) {
        lastDone = snap.doneItems;
        stagnantTicks = 0;
      } else {
        stagnantTicks++;
      }
      const nextDelay = stagnantTicks >= 2 ? POLL_SLOW_MS : POLL_FAST_MS;
      pollTimer.current = setTimeout(tick, nextDelay);
    };

    tick();

    return () => {
      cancelled.current = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
      setIsPolling(false);
    };
  }, [jobId, email, fetchOnce]);

  const refresh = useCallback(async () => {
    return fetchOnce();
  }, [fetchOnce]);

  return { snapshot, error, isPolling, refresh };
}
