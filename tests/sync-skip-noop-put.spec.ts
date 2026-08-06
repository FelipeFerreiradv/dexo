import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

/**
 * `updateData.price` é setado incondicionalmente, então TODO save de produto
 * disparava um PUT por anúncio mesmo sem nada ter mudado. Em ~220 mil anúncios
 * ativos isso é egress e rate limit do ML puro.
 *
 * O corte só vale quando o payload inteiro se resume a price/available_quantity
 * e os DOIS já batem com o item remoto que acabamos de ler. Qualquer outra
 * chave manda como antes — fail-open, na dúvida envia.
 */
const FAMILY_NAME_ML = "Porta Dianteira Direita Byd Dolphin Plus 2024 2025 2026";

const itemUp = (over: Record<string, unknown> = {}) => ({
  id: "MLB-1",
  status: "active",
  available_quantity: 1,
  price: 1450,
  title: `${FAMILY_NAME_ML} Dianteira Direita Branco`,
  family_name: FAMILY_NAME_ML,
  user_product_id: "MLBU-1",
  sold_quantity: 0,
  has_bids: false,
  ...over,
});

const produto = (over: Record<string, unknown> = {}) => ({
  id: "prod-1",
  sku: "500542",
  name: "PORTA DIANTEIRA DIREITA BYD DOLPHIN PLUS 2024 2025 2026",
  price: 1450,
  stock: 1,
  ...over,
});

describe("SyncUseCase.syncMLProductData → corte do PUT redundante", () => {
  // `any` de propósito: os spies têm assinaturas diferentes entre si e o
  // `ReturnType<typeof vi.spyOn>` do vitest 1.6 não unifica.
  let updateSpy: any;
  let logSpy: any;

  beforeEach(() => {
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma.productListing, "findFirst").mockResolvedValue(null as any);
    vi.spyOn(MLApiService, "upsertDescription").mockResolvedValue({} as any);
    vi.spyOn(SyncUseCase, "republishUpListing").mockResolvedValue({
      republished: true,
    } as any);
    updateSpy = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({ id: "MLB-1" } as any);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ML_SYNC_SKIP_NOOP_PUT_DISABLED;
  });

  const rodar = async (item: unknown, prod: unknown) => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(item as any);
    return (SyncUseCase as any).syncMLProductData(prod, "MLB-1", {
      id: "acc-1",
      accessToken: "tok",
      userId: "user-1",
    });
  };

  it("preço e estoque já iguais ao remoto: nenhum PUT, e o sync continua com sucesso", async () => {
    const r = await rodar(itemUp(), produto());

    expect(updateSpy).not.toHaveBeenCalled();
    expect(r.success).toBe(true);
    const ev = logSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .filter(
        (l: unknown): l is string =>
          typeof l === "string" && l.includes("ml.sync.put_skipped"),
      )
      .map((l: string) => JSON.parse(l))[0];
    expect(ev).toMatchObject({
      event: "ml.sync.put_skipped",
      reason: "no_change",
      externalListingId: "MLB-1",
      price: 1450,
      availableQuantity: 1,
    });
  });

  it("preço diferente: manda o PUT", async () => {
    await rodar(itemUp({ price: 1440 }), produto());

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][2]).toMatchObject({ price: 1450 });
  });

  it("estoque diferente: manda o PUT", async () => {
    await rodar(itemUp({ available_quantity: 3 }), produto());

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][2]).toMatchObject({
      available_quantity: 1,
    });
  });

  it("fail-open: com qualquer outra chave no payload (description em item legado) o PUT sai", async () => {
    // Item sem family_name/user_product_id => description entra no payload.
    await rodar(
      {
        id: "MLB-1",
        status: "active",
        available_quantity: 1,
        price: 1450,
        title: "Farol Dianteiro",
        sold_quantity: 0,
      },
      produto({ name: "Farol Dianteiro", description: "Peça original" }),
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][2]).toHaveProperty("description");
  });

  it("kill-switch ML_SYNC_SKIP_NOOP_PUT_DISABLED restaura o PUT incondicional", async () => {
    process.env.ML_SYNC_SKIP_NOOP_PUT_DISABLED = "1";

    await rodar(itemUp(), produto());

    expect(updateSpy).toHaveBeenCalledTimes(1);
  });
});
