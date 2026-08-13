import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// P2.2 — o badge do mascote.
//
// ⭐⭐ AS DUAS AFIRMAÇÕES QUE ESTE SPEC EXISTE PARA PROVAR:
//
//  1. O BADGE NÃO CONTA O QUE O ATOR NÃO PODE VER. Um ponto vermelho que diz
//     "você tem 61 problemas" para quem não abre a tela de Pedidos já vazou o
//     número — e o vazamento é do SERVIDOR, então esconder no navegador não
//     resolveria nada.
//
//  2. ⭐⭐ A CATRACA GIRA NOS DOIS SENTIDOS. É o defeito que mata o recurso em
//     silêncio: sem baixar a marca quando o problema é RESOLVIDO, o lojista que
//     zera as pendências nunca mais recebe aviso nenhum. Ele não descobriria —
//     não há erro, não há log, o badge simplesmente não acende mais.
// ===========================================================================

const contarPendenciasMock = vi.fn();
const contarContasMock = vi.fn();

vi.mock("../app/lib/prisma", () => ({
  default: {
    orderIngestionIssue: { count: (...a: any[]) => contarPendenciasMock(...a) },
    marketplaceAccount: { count: (...a: any[]) => contarContasMock(...a) },
  },
}));

import { contarAlertas } from "../app/ai/alertas/alertas.service";

/** Um escopo com as páginas que o teste escolher. `AiScope` é nominal. */
const escopo = (paginas: string[] | "todas") =>
  ({
    dataOwnerId: "t1",
    actorId: "u1",
    isAdmin: true,
    can: (p: string) => paginas === "todas" || paginas.includes(p),
    canAction: () => true,
  }) as any;

const TODAS = "todas" as const;

beforeEach(() => {
  contarPendenciasMock.mockReset().mockResolvedValue(0);
  contarContasMock.mockReset().mockResolvedValue(0);
});

// ---------------------------------------------------------------------------

describe("⭐⭐ o badge não conta o que o ator não pode ver", () => {
  it("sem a página de Pedidos, `pedidosTravados` é null E a consulta NÃO acontece", async () => {
    const r = await contarAlertas(escopo(["mercado-livre"]));

    expect(r.pedidosTravados).toBeNull();
    // Não basta esconder o número: a consulta nem sai. É o que garante que o
    // dado não passa por lugar nenhum onde possa vazar depois.
    expect(contarPendenciasMock).not.toHaveBeenCalled();
  });

  it("sem canal nenhum, `contasCaidas` é null e a consulta NÃO acontece", async () => {
    const r = await contarAlertas(escopo(["pedidos"]));

    expect(r.contasCaidas).toBeNull();
    expect(contarContasMock).not.toHaveBeenCalled();
  });

  it("⭐ com UM canal só, conta apenas aquele canal", async () => {
    await contarAlertas(escopo(["shopee"]));

    expect(contarContasMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          platform: { in: ["SHOPEE"] },
        }),
      }),
    );
  });

  it("com acesso total, os cinco canais entram", async () => {
    await contarAlertas(escopo(TODAS));

    const onde = contarContasMock.mock.calls[0][0].where;
    expect(onde.platform.in).toEqual(
      expect.arrayContaining([
        "MERCADO_LIVRE",
        "SHOPEE",
        "MAGALU",
        "OLX",
        "FACEBOOK",
      ]),
    );
    expect(onde.platform.in).toHaveLength(5);
  });
});

describe("⭐ o tenant sai do escopo, nunca de outro lugar", () => {
  it("as duas consultas são escopadas por `dataOwnerId`", async () => {
    await contarAlertas(escopo(TODAS));

    expect(contarPendenciasMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          marketplaceAccount: { userId: "t1" },
        }),
      }),
    );
    expect(contarContasMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "t1" }),
      }),
    );
  });
});

describe("⭐ o que entra e o que fica de fora", () => {
  it("pendência é OPEN **e** NEEDS_ACTION — o mesmo filtro da tela de Pedidos", async () => {
    await contarAlertas(escopo(TODAS));

    const onde = contarPendenciasMock.mock.calls[0][0].where;
    expect(onde.status).toEqual({ in: ["OPEN", "NEEDS_ACTION"] });
  });

  it("⚠️ conta só em ERROR — `INACTIVE` é o modo férias, ligado de propósito", async () => {
    await contarAlertas(escopo(TODAS));

    const onde = contarContasMock.mock.calls[0][0].where;
    expect(onde.status).toBe("ERROR");
  });

  it("os números chegam inteiros ao cliente", async () => {
    contarPendenciasMock.mockResolvedValue(61);
    contarContasMock.mockResolvedValue(2);

    const r = await contarAlertas(escopo(TODAS));

    expect(r).toEqual({ pedidosTravados: 61, contasCaidas: 2 });
  });
});

describe("⚠️ alerta é enfeite: consulta que estoura não derruba o mascote", () => {
  it("banco fora do ar vira zero, não exceção", async () => {
    contarPendenciasMock.mockRejectedValue(new Error("pool esgotado"));
    contarContasMock.mockRejectedValue(new Error("pool esgotado"));

    const r = await contarAlertas(escopo(TODAS));

    expect(r).toEqual({ pedidosTravados: 0, contasCaidas: 0 });
  });
});

// ===========================================================================
// A CATRACA. Roda em `environment: "node"`, então o `window.localStorage` que o
// módulo usa é montado aqui à mão — de propósito: o que precisa ser provado é a
// ARITMÉTICA da catraca, e um teste que só lesse o fonte provaria que a linha
// existe, não que ela decide certo.
// ===========================================================================

describe("⭐⭐ a catraca — o badge avisa por PIORA, não por existência", () => {
  let guardado: Record<string, string>;
  let quebrado = false;

  beforeEach(async () => {
    guardado = {};
    quebrado = false;
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => {
          if (quebrado) throw new Error("storage bloqueado");
          return guardado[k] ?? null;
        },
        setItem: (k: string, v: string) => {
          if (quebrado) throw new Error("storage bloqueado");
          guardado[k] = v;
        },
      },
    };
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  const carregar = () =>
    import("../components/bitz/bitz-alerta-catraca");

  it("primeira vez, com problema: avisa", async () => {
    const { avaliar } = await carregar();
    expect(avaliar("u1", { pedidosTravados: 61, contasCaidas: 0 })).toBe(true);
  });

  it("sem problema nenhum: não avisa", async () => {
    const { avaliar } = await carregar();
    expect(avaliar("u1", { pedidosTravados: 0, contasCaidas: 0 })).toBe(false);
  });

  it("depois de dispensar, o MESMO número não avisa de novo", async () => {
    const { avaliar, dispensar } = await carregar();

    dispensar("u1", { pedidosTravados: 61, contasCaidas: 0 });

    expect(avaliar("u1", { pedidosTravados: 61, contasCaidas: 0 })).toBe(false);
  });

  it("⭐ um problema NOVO em cima do dispensado avisa", async () => {
    const { avaliar, dispensar } = await carregar();

    dispensar("u1", { pedidosTravados: 61, contasCaidas: 0 });

    expect(avaliar("u1", { pedidosTravados: 62, contasCaidas: 0 })).toBe(true);
  });

  it("melhora sozinha NÃO avisa — ninguém precisa ser interrompido por boa notícia", async () => {
    const { avaliar, dispensar } = await carregar();

    dispensar("u1", { pedidosTravados: 61, contasCaidas: 0 });

    expect(avaliar("u1", { pedidosTravados: 55, contasCaidas: 0 })).toBe(false);
  });

  it("⭐⭐ RESOLVEU TUDO E VOLTOU UM: avisa. É a catraca girando para baixo", async () => {
    const { avaliar, dispensar } = await carregar();

    // O lojista dispensa com 61 pendências abertas.
    dispensar("u1", { pedidosTravados: 61, contasCaidas: 0 });
    // Depois de dias de trabalho, ele zera. Nada a avisar.
    expect(avaliar("u1", { pedidosTravados: 0, contasCaidas: 0 })).toBe(false);

    // E aí chega UMA pendência nova.
    //
    // ⛔ SEM A REGRAVAÇÃO PARA BAIXO, `1 > 61` é falso e este alerta MORRE EM
    // SILÊNCIO — para sempre, sem erro, sem log, sem ninguém descobrir.
    expect(avaliar("u1", { pedidosTravados: 1, contasCaidas: 0 })).toBe(true);
  });

  it("o segundo contador tem catraca própria", async () => {
    const { avaliar, dispensar } = await carregar();

    dispensar("u1", { pedidosTravados: 61, contasCaidas: 0 });

    // Pendências iguais, mas uma conta caiu agora.
    expect(avaliar("u1", { pedidosTravados: 61, contasCaidas: 1 })).toBe(true);
  });

  it("⭐ a marca é POR USUÁRIO — o balconista não herda a dispensa do dono", async () => {
    const { avaliar, dispensar } = await carregar();

    dispensar("dono", { pedidosTravados: 61, contasCaidas: 0 });

    expect(avaliar("balconista", { pedidosTravados: 61, contasCaidas: 0 })).toBe(
      true,
    );
  });

  it("⚠️ storage bloqueado: NÃO avisa (senão seria um badge que não desliga)", async () => {
    const { avaliar } = await carregar();
    quebrado = true;

    expect(avaliar("u1", { pedidosTravados: 61, contasCaidas: 0 })).toBe(false);
  });

  it("lixo no storage não quebra nada — volta como marca zerada", async () => {
    const { avaliar } = await carregar();
    guardado["dexo:bitz:alerta:u1"] = "isto não é json";

    expect(avaliar("u1", { pedidosTravados: 3, contasCaidas: 0 })).toBe(false);
  });
});
