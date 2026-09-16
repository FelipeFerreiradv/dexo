/**
 * PAUSA-AO-ZERAR NA BAIXA DE PEDIDO — preferência POR TENANT.
 *
 * O diagnóstico de 15/09/2026 mostrou o custo de não pausar: o ML RECUSA
 * zerar a quantidade de anúncio fora do ar, então a peça vendida ficava
 * vendável no anúncio até a vigília passar (o SKU 34049 ficou 57 dias). Só a
 * venda de balcão pausava; o pedido de marketplace — o caminho onde o
 * oversell de fato acontece — não.
 *
 * A preferência é User.pauseListingsOnOrderZero, default false: pausar muda o
 * comportamento VISÍVEL do lojista, então liga cliente a cliente. Os
 * invariantes travados aqui:
 *   - a resolução parte do marketplaceAccountId (o select do repositório NÃO
 *     projeta userId na relação — ler de order.marketplaceAccount.userId
 *     seria undefined em runtime e a preferência nunca dispararia);
 *   - o userId devolvido é o DONO do tenant (parentUserId ?? id), porque
 *     pauseListings confere product.userId estrito;
 *   - default/ausente/erro ⇒ comportamento de SEMPRE (undefined);
 *   - caminho quente sem zerar ⇒ ZERO consulta;
 *   - a baixa de pedido JAMAIS quebra por causa da preferência (fail-safe).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/prisma", () => ({
  default: {
    marketplaceAccount: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import prisma from "@/app/lib/prisma";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";

const decide = (
  deductions: Array<{ newStock: number }>,
  marketplaceAccountId?: string | null,
) => (OrderUseCase as any).pauseOnZeroSeTenantOptou(deductions, marketplaceAccountId);

const contaDe = (user: Record<string, unknown> | null) =>
  (prisma as any).marketplaceAccount.findUnique.mockResolvedValue(
    user ? { user } : null,
  );

describe("OrderUseCase.pauseOnZeroSeTenantOptou", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("nada zerou: undefined e ZERO consulta — o caminho quente não paga nada", async () => {
    const r = await decide([{ newStock: 3 }, { newStock: 1 }], "acc-1");

    expect(r).toBeUndefined();
    expect((prisma as any).marketplaceAccount.findUnique).not.toHaveBeenCalled();
    expect((prisma as any).user.findUnique).not.toHaveBeenCalled();
  });

  it("zerou e o DONO optou: {userId do dono} com um select enxuto via conta", async () => {
    contaDe({ id: "dono-1", parentUserId: null, pauseListingsOnOrderZero: true });

    const r = await decide([{ newStock: 0 }], "acc-1");

    expect(r).toEqual({ userId: "dono-1" });
    expect((prisma as any).marketplaceAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "acc-1" },
      select: {
        user: {
          select: {
            id: true,
            parentUserId: true,
            pauseListingsOnOrderZero: true,
          },
        },
      },
    });
    // Dono direto: resolve em UMA consulta, sem segundo hop.
    expect((prisma as any).user.findUnique).not.toHaveBeenCalled();
  });

  it("zerou mas o tenant NÃO optou (default): comportamento de sempre", async () => {
    contaDe({ id: "dono-1", parentUserId: null, pauseListingsOnOrderZero: false });

    const r = await decide([{ newStock: 0 }], "acc-1");

    expect(r).toBeUndefined();
  });

  it("conta pendurada em COLABORADOR: lê a preferência do admin pai e devolve o id do PAI", async () => {
    contaDe({ id: "colab-1", parentUserId: "dono-1", pauseListingsOnOrderZero: false });
    (prisma as any).user.findUnique.mockResolvedValue({
      pauseListingsOnOrderZero: true,
    });

    const r = await decide([{ newStock: 0 }], "acc-1");

    // Produtos pertencem ao dono (parentUserId ?? id) e pauseListings confere
    // product.userId estrito: devolver o id do colaborador tornaria a pausa
    // um no-op silencioso ("Produto não encontrado").
    expect(r).toEqual({ userId: "dono-1" });
    expect((prisma as any).user.findUnique).toHaveBeenCalledWith({
      where: { id: "dono-1" },
      select: { pauseListingsOnOrderZero: true },
    });
  });

  it("fail-safe: consulta lança (coluna ausente, client antigo) ⇒ comportamento de sempre", async () => {
    (prisma as any).marketplaceAccount.findUnique.mockRejectedValue(
      new Error("Unknown field pauseListingsOnOrderZero"),
    );

    const r = await decide([{ newStock: 0 }], "acc-1");

    // A baixa de pedido é o caminho mais sensível do sistema — uma
    // preferência opcional jamais pode derrubá-lo.
    expect(r).toBeUndefined();
  });

  it("conta inexistente ou id ausente: undefined, sem explodir", async () => {
    contaDe(null);
    expect(await decide([{ newStock: 0 }], "acc-orfa")).toBeUndefined();

    expect(await decide([{ newStock: 0 }], undefined)).toBeUndefined();
  });
});
