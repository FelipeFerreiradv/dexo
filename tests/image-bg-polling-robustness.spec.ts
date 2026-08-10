/**
 * Robustez do polling do recorte assíncrono (10/08/2026).
 *
 * Contexto: em produção o recorte NÃO falha — ele demora (p50 2min, p90 6,8min,
 * porque o sidecar é 1 worker de CPU a ~10s por imagem). O que transformava
 * "demorado" em "travado para sempre" eram dois buracos no cliente:
 *
 *   1. `fetchImageBgJobs` sem deadline. O hook só agenda o próximo tick DEPOIS
 *      do `await`, então um socket pendurado congelava a cadeia inteira.
 *   2. Id pedido que nunca volta na resposta ficava preso em PENDING e o
 *      polling não parava nunca.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IMAGE_BG_FETCH_TIMEOUT_MS,
  bgJobProgressLabel,
  fetchImageBgJobs,
} from "../lib/image-bg-jobs";
import {
  MISSING_TICKS_BEFORE_LOST,
  trackMissingIds,
} from "../hooks/use-image-bg-jobs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("fetchImageBgJobs — deadline", () => {
  it("aborta quando o servidor pendura o socket (senão o polling congela para sempre)", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      // Nunca resolve por conta própria: só o abort encerra.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("AbortError")),
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchImageBgJobs(["j1"]);
    // `catch` já registrado: o rejeito abaixo não vira unhandled rejection.
    const settled = pending.then(
      () => "resolveu",
      () => "rejeitou",
    );

    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(IMAGE_BG_FETCH_TIMEOUT_MS);

    expect(signal?.aborted).toBe(true);
    expect(await settled).toBe("rejeitou");
  });

  it("passa signal sem NUNCA setar authorization (invariante 3 do auth-bridge)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ jobs: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchImageBgJobs(["j1"]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init as { headers?: unknown }).headers).toBeUndefined();
  });
});

describe("trackMissingIds — ausência consecutiva", () => {
  it("só dá o id por perdido após N respostas CONSECUTIVAS sem ele", () => {
    const streaks = new Map<string, number>();
    for (let i = 1; i < MISSING_TICKS_BEFORE_LOST; i += 1) {
      expect(trackMissingIds(["j1"], [], streaks)).toEqual([]);
    }
    expect(trackMissingIds(["j1"], [], streaks)).toEqual(["j1"]);
  });

  it("reaparecer ZERA o contador — resposta parcial passageira não condena", () => {
    const streaks = new Map<string, number>();
    // Quase no limite...
    for (let i = 1; i < MISSING_TICKS_BEFORE_LOST; i += 1) {
      trackMissingIds(["j1"], [], streaks);
    }
    // ...e volta a aparecer.
    expect(trackMissingIds(["j1"], ["j1"], streaks)).toEqual([]);
    expect(streaks.has("j1")).toBe(false);

    // A partir daqui precisa da sequência INTEIRA de novo.
    for (let i = 1; i < MISSING_TICKS_BEFORE_LOST; i += 1) {
      expect(trackMissingIds(["j1"], [], streaks)).toEqual([]);
    }
    expect(trackMissingIds(["j1"], [], streaks)).toEqual(["j1"]);
  });

  it("não confunde ids: quem volta não afeta o contador de quem sumiu", () => {
    const streaks = new Map<string, number>();
    let lost: string[] = [];
    for (let i = 0; i < MISSING_TICKS_BEFORE_LOST; i += 1) {
      lost = trackMissingIds(["j1", "j2"], ["j1"], streaks);
    }
    expect(lost).toEqual(["j2"]);
    expect(streaks.has("j1")).toBe(false);
  });
});

describe("bgJobProgressLabel — UX honesta da espera", () => {
  it("abaixo de 1 min não promete nada além de estar recortando", () => {
    expect(bgJobProgressLabel(0).short).toBe("Recortando fundo…");
    expect(bgJobProgressLabel(59_000).short).toBe("Recortando fundo…");
  });

  it("de 1 a 5 min mostra o tempo e libera o salvamento", () => {
    const um = bgJobProgressLabel(60_000);
    expect(um.short).toContain("1 min");
    expect(um.short).toContain("pode salvar");
    expect(bgJobProgressLabel(4 * 60_000).short).toContain("4 min");
  });

  it("acima de 5 min diz que pode FECHAR — o swap é feito no servidor", () => {
    const seis = bgJobProgressLabel(6 * 60_000);
    expect(seis.short).toContain("6 min");
    expect(seis.short).toContain("fechar");
    expect(seis.full).toContain("mesmo com esta tela fechada");
  });

  it("tempo negativo (relógio pulando) não vira texto quebrado", () => {
    expect(bgJobProgressLabel(-5_000).short).toBe("Recortando fundo…");
  });
});
