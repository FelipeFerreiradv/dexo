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
/**
 * Respostas CONSECUTIVAS em que um id pedido não voltou antes de o darmos por
 * perdido (≈25s no tick lento).
 *
 * O `GET /upload/image/jobs` filtra por `{ id in ids, userId }` e simplesmente
 * OMITE o que não achou (deliberado: não vaza existência de job de outro
 * tenant). Sem este contador, um id que nunca volta — job podado do banco,
 * troca de sessão/tenant, id órfão no estado — fica preso em PENDING e o
 * polling não para NUNCA. Só contamos quando o servidor de fato respondeu:
 * erro de rede não é evidência de que o job sumiu.
 */
export const MISSING_TICKS_BEFORE_LOST = 5;

/**
 * Contabiliza ausências CONSECUTIVAS e devolve os ids já dados por perdidos.
 *
 * Extraído do efeito para ser testável sem DOM (a suíte não tem `renderHook`).
 * Muta `streaks` de propósito: é o estado que atravessa os ticks.
 */
export function trackMissingIds(
  requestedIds: string[],
  returnedIds: string[],
  streaks: Map<string, number>,
): string[] {
  const present = new Set(returnedIds);
  const lost: string[] = [];
  for (const id of requestedIds) {
    if (present.has(id)) {
      // Reaparecer ZERA: resposta parcial passageira não condena ninguém.
      streaks.delete(id);
      continue;
    }
    const streak = (streaks.get(id) ?? 0) + 1;
    streaks.set(id, streak);
    if (streak >= MISSING_TICKS_BEFORE_LOST) lost.push(id);
  }
  return lost;
}

export function useImageBgJobs(
  jobIds: string[],
  onUpdate: (jobs: ImageBgJobStatus[], missingIds: string[]) => void,
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
    const missingStreak = new Map<string, number>();

    const tick = async () => {
      if (cancelled) return;
      try {
        const jobs = await fetchImageBgJobs(ids);
        if (cancelled) return;
        const snapshot = jobs.map((j) => `${j.id}:${j.status}`).join("|");
        unchangedTicks = snapshot === lastSnapshot ? unchangedTicks + 1 : 0;
        lastSnapshot = snapshot;

        const missingIds = trackMissingIds(
          ids,
          jobs.map((j) => j.id),
          missingStreak,
        );

        onUpdateRef.current(jobs, missingIds);
      } catch {
        // Falha de rede no polling é silenciosa: o próximo tick tenta de
        // novo. (O job continua andando no servidor de qualquer forma.)
        // NÃO mexe em `missingStreak`: sem resposta do servidor não há
        // evidência de que o job sumiu.
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
