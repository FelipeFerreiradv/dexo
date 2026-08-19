"use client";

/**
 * Polling adaptativo dos jobs de recorte assíncrono (PR 4).
 *
 * Molde: `app/produtos/hooks/use-bulk-listing-job.ts` (setTimeout recursivo,
 * tick rápido→lento, cleanup por flag). O chamador mantém a lista de jobIds
 * ATIVOS (remove os terminais ao recebê-los em onUpdate) — quando a lista
 * esvazia, o polling para sozinho.
 *
 * O polling é GATEADO POR VISIBILIDADE (convenção do repo: `app-sidebar.tsx`,
 * `update-notifier.tsx`, `messages-shell.tsx`): aba escondida não consulta.
 * Isso não muda o desfecho — o recorte e o swap acontecem no servidor — só
 * para de gastar requisição por uma tela que ninguém está olhando. Ao voltar o
 * foco, consulta na hora e volta ao tick rápido.
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

    // Um tick só agenda o próximo DEPOIS de resolver, então nunca há dois na
    // mesma cadeia. O listener de foco é a única fonte externa de tick — sem
    // esta flag ele poderia disparar um segundo enquanto o primeiro está no
    // `await`, e aí seriam DUAS cadeias polling para sempre.
    let inFlight = false;

    const tick = async () => {
      if (cancelled) return;
      // Aba em segundo plano não consulta nada: o recorte continua andando no
      // SERVIDOR e o swap é feito lá (por isso a UI diz "pode salvar e
      // fechar"). Perguntar de 5 em 5s para uma tela que ninguém está vendo é
      // egress puro. Mantemos um timer lento só para a cadeia não morrer caso
      // o `visibilitychange` não chegue; ao voltar o foco o listener dispara um
      // tick IMEDIATO e a tela alcança o servidor.
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(() => void tick(), POLL_SLOW_MS);
        return;
      }
      inFlight = true;
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
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      const delay =
        unchangedTicks >= SLOWDOWN_AFTER_TICKS ? POLL_SLOW_MS : POLL_FAST_MS;
      timer = setTimeout(() => void tick(), delay);
    };

    // Voltou o foco: alcança o servidor NA HORA em vez de esperar o timer, e
    // volta ao tick rápido — quem reabriu a aba quer ver o recorte agora.
    const onVisibilityChange = () => {
      if (cancelled || document.hidden || inFlight) return;
      if (timer) clearTimeout(timer);
      unchangedTicks = 0;
      void tick();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [key]);
}
