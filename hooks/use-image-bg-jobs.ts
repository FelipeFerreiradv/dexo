"use client";

/**
 * Polling adaptativo dos jobs de recorte assíncrono (PR 4).
 *
 * Molde: `app/produtos/hooks/use-bulk-listing-job.ts` (setTimeout recursivo,
 * tick rápido→lento, cleanup por flag). O chamador mantém a lista de jobIds
 * ATIVOS (remove os terminais ao recebê-los em onUpdate) — quando a lista
 * esvazia, o polling para sozinho.
 */

import { useEffect, useRef } from "react";
import {
  fetchImageBgJobs,
  type ImageBgJobStatus,
} from "@/lib/image-bg-jobs";

const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 5_000;
/** Ticks sem NENHUMA mudança de status antes de desacelerar. */
const SLOWDOWN_AFTER_TICKS = 3;

export function useImageBgJobs(
  jobIds: string[],
  onUpdate: (jobs: ImageBgJobStatus[]) => void,
): void {
  // Callback sempre atual sem reiniciar o efeito (padrão do repo).
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  const key = jobIds.slice().sort().join(",");

  useEffect(() => {
    if (!key) return;
    const ids = key.split(",");
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unchangedTicks = 0;
    let lastSnapshot = "";

    const tick = async () => {
      if (cancelled) return;
      try {
        const jobs = await fetchImageBgJobs(ids);
        if (cancelled) return;
        const snapshot = jobs.map((j) => `${j.id}:${j.status}`).join("|");
        unchangedTicks = snapshot === lastSnapshot ? unchangedTicks + 1 : 0;
        lastSnapshot = snapshot;
        onUpdateRef.current(jobs);
      } catch {
        // Falha de rede no polling é silenciosa: o próximo tick tenta de
        // novo. (O job continua andando no servidor de qualquer forma.)
        unchangedTicks += 1;
      }
      if (cancelled) return;
      const delay =
        unchangedTicks >= SLOWDOWN_AFTER_TICKS ? POLL_SLOW_MS : POLL_FAST_MS;
      timer = setTimeout(() => void tick(), delay);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);
}
