import { describe, it, expect, vi } from "vitest";
import {
  criarCacheDeToken,
  tokenAindaVale,
  TOKEN_SKEW_MS,
  type MLTokenSnapshot,
} from "../scripts/lib/ml-token-cache";

/**
 * Incidente de 25/07/2026 no backfill de compatibilidade.
 *
 * O cache de token era `Map<string, string>` e a checagem de validade só
 * rodava quando o cache estava VAZIO — uma vez por processo. Numa corrida de
 * 5.361 anúncios, que passa das 6h de vida do token do ML, ele morria no meio:
 * **887 anúncios gravados e 4.497 falhas seguidas com 401 "invalid access
 * token"**.
 *
 * Estes testes travam as duas metades: renovar quando vence, e usar o refresh
 * token ROTACIONADO na renovação seguinte.
 */

const UMA_HORA = 60 * 60 * 1000;

function snapshot(over: Partial<MLTokenSnapshot> = {}): MLTokenSnapshot {
  return {
    id: "conta-1",
    accessToken: "token-do-banco",
    refreshToken: "refresh-do-banco",
    expiresAt: new Date(6 * UMA_HORA),
    ...over,
  };
}

/** Relógio controlado: o bug só aparece com o tempo passando. */
function relogio(inicial: number) {
  let t = inicial;
  return {
    agora: () => t,
    avancar: (ms: number) => {
      t += ms;
    },
  };
}

describe("tokenAindaVale", () => {
  it("vale enquanto houver folga maior que a margem", () => {
    expect(tokenAindaVale(1000 + TOKEN_SKEW_MS + 1, 1000)).toBe(true);
  });

  it("NAO vale dentro da margem — renovar antes do vencimento real", () => {
    // Ainda não venceu, mas venceria no meio das requisições em voo.
    expect(tokenAindaVale(1000 + TOKEN_SKEW_MS - 1, 1000)).toBe(false);
  });

  it("NAO vale depois de vencido", () => {
    expect(tokenAindaVale(500, 1000)).toBe(false);
  });

  it("valor nao finito nunca vale", () => {
    expect(tokenAindaVale(Number.NaN, 1000)).toBe(false);
  });
});

describe("criarCacheDeToken", () => {
  it("usa o token do banco quando ainda tem folga, sem renovar", async () => {
    const refresh = vi.fn();
    const persist = vi.fn();
    const rel = relogio(0);
    const get = criarCacheDeToken({ refresh, persist, agora: rel.agora });

    const token = await get(snapshot());

    expect(token).toBe("token-do-banco");
    expect(refresh).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("reusa do cache dentro da validade — nao renova a cada anuncio", async () => {
    const refresh = vi.fn();
    const persist = vi.fn();
    const rel = relogio(0);
    const get = criarCacheDeToken({ refresh, persist, agora: rel.agora });

    for (let i = 0; i < 500; i++) await get(snapshot());

    expect(refresh).not.toHaveBeenCalled();
  });

  it("REGRESSAO: renova quando o token vence no meio da corrida", async () => {
    // Este é o incidente. Antes, a segunda chamada devolvia o token morto.
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "token-novo",
      refreshToken: "refresh-novo",
      expiresIn: 6 * 60 * 60,
    });
    const persist = vi.fn().mockResolvedValue(undefined);
    const rel = relogio(0);
    const get = criarCacheDeToken({ refresh, persist, agora: rel.agora });

    const antes = await get(snapshot());
    expect(antes).toBe("token-do-banco");

    rel.avancar(6 * UMA_HORA + 1);

    const depois = await get(snapshot());
    expect(depois).toBe("token-novo");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("REGRESSAO: a 2a renovacao usa o refresh token ROTACIONADO", async () => {
    // O ML rotaciona o refresh token. Reler o do snapshot inicial usaria um
    // valor já consumido e a segunda renovação falharia.
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({
        accessToken: "token-2",
        refreshToken: "refresh-2",
        expiresIn: 3600,
      })
      .mockResolvedValueOnce({
        accessToken: "token-3",
        refreshToken: "refresh-3",
        expiresIn: 3600,
      });
    const persist = vi.fn().mockResolvedValue(undefined);
    const rel = relogio(0);
    const get = criarCacheDeToken({ refresh, persist, agora: rel.agora });

    // Snapshot já vencido: força renovação na primeira chamada.
    const conta = snapshot({ expiresAt: new Date(0) });

    await get(conta);
    rel.avancar(2 * UMA_HORA);
    await get(conta);

    expect(refresh).toHaveBeenNthCalledWith(1, "conta-1", "refresh-do-banco");
    expect(refresh).toHaveBeenNthCalledWith(2, "conta-1", "refresh-2");
  });

  it("persiste o par novo no banco a cada renovacao", async () => {
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "token-novo",
      refreshToken: "refresh-novo",
      expiresIn: 3600,
    });
    const persist = vi.fn().mockResolvedValue(undefined);
    const rel = relogio(1_000_000);
    const get = criarCacheDeToken({ refresh, persist, agora: rel.agora });

    await get(snapshot({ expiresAt: new Date(0) }));

    expect(persist).toHaveBeenCalledWith("conta-1", {
      accessToken: "token-novo",
      refreshToken: "refresh-novo",
      expiresAt: new Date(1_000_000 + 3600 * 1000),
    });
  });

  it("duas chamadas concorrentes disparam UMA renovacao so", async () => {
    let resolver: (v: unknown) => void = () => {};
    const refresh = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolver = r as (v: unknown) => void;
        }),
    );
    const persist = vi.fn().mockResolvedValue(undefined);
    const get = criarCacheDeToken({ refresh, persist, agora: () => 0 });

    const conta = snapshot({ expiresAt: new Date(0) });
    const a = get(conta);
    const b = get(conta);

    resolver({
      accessToken: "token-novo",
      refreshToken: "refresh-novo",
      expiresIn: 3600,
    });

    expect(await a).toBe("token-novo");
    expect(await b).toBe("token-novo");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("contas diferentes tem tokens independentes", async () => {
    const refresh = vi.fn();
    const persist = vi.fn();
    const get = criarCacheDeToken({ refresh, persist, agora: () => 0 });

    const t1 = await get(snapshot({ id: "a", accessToken: "token-a" }));
    const t2 = await get(snapshot({ id: "b", accessToken: "token-b" }));

    expect(t1).toBe("token-a");
    expect(t2).toBe("token-b");
    expect(refresh).not.toHaveBeenCalled();
  });
});
