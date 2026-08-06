import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

/**
 * Regressão do bug de produção: salvar SÓ o preço de um produto com anúncio
 * User Product fazia o Dexo criar um anúncio novo e fechar o antigo.
 *
 * Os valores abaixo são os REAIS medidos no anúncio que originou o relato
 * (tenant Mesquita Autopeças, SKU 500542, categoria MLB101763). O ML
 * Title-Case-ia o family_name que enviamos e ANEXA ao title os atributos que
 * diferenciam a família — por isso `product.name !== currentItem.title` era
 * verdadeiro por construção.
 */
const NOME_PRODUTO = "PORTA DIANTEIRA DIREITA BYD DOLPHIN PLUS 2024 2025 2026";
const FAMILY_NAME_ML = "Porta Dianteira Direita Byd Dolphin Plus 2024 2025 2026";
const TITLE_ML =
  "Porta Dianteira Direita Byd Dolphin Plus 2024 2025 2026 Dianteira Direita Branco";

const ACCOUNT = { id: "acc-1", accessToken: "tok-secreto", userId: "user-1" };

const itemUp = (over: Record<string, unknown> = {}) => ({
  id: "MLB7319051094",
  status: "active",
  available_quantity: 1,
  price: 1440,
  title: TITLE_ML,
  family_name: FAMILY_NAME_ML,
  user_product_id: "MLBU4546804381",
  category_id: "MLB101763",
  sold_quantity: 0,
  has_bids: false,
  ...over,
});

const produto = (over: Record<string, unknown> = {}) => ({
  id: "prod-1",
  sku: "500542",
  name: NOME_PRODUTO,
  description: "Desc",
  price: 1450,
  stock: 1,
  ...over,
});

describe("SyncUseCase.syncMLProductData → comparação de título em item UP", () => {
  let republishSpy: ReturnType<typeof vi.spyOn>;
  let updateSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma.productListing, "findFirst").mockResolvedValue(null as any);
    vi.spyOn(MLApiService, "upsertDescription").mockResolvedValue({} as any);
    updateSpy = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue({ id: "MLB7319051094" } as any);
    republishSpy = vi
      .spyOn(SyncUseCase, "republishUpListing")
      .mockResolvedValue({
        republished: true,
        newExternalListingId: "MLB-NOVO",
      } as any);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ML_UP_TITLE_COMPARE_DISABLED;
  });

  const rodar = async (item: unknown, prod: unknown) => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(item as any);
    await (SyncUseCase as any).syncMLProductData(
      prod,
      "MLB7319051094",
      ACCOUNT,
    );
  };

  /** Lê as linhas de log estruturado de um evento específico. */
  const eventos = (spy: ReturnType<typeof vi.spyOn>, nome: string) =>
    spy.mock.calls
      .map((c) => c[0])
      .filter((l): l is string => typeof l === "string" && l.includes(nome))
      .map((l) => JSON.parse(l));

  it("CASO DO VÍDEO: edição só de preço NÃO republica e manda um único PUT sem title", async () => {
    await rodar(itemUp(), produto());

    expect(republishSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const body = updateSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(body.price).toBe(1450);
    expect(body).not.toHaveProperty("title");
  });

  it("loga ml.up.title.compare com decision=skip e sem vazar o access token", async () => {
    await rodar(itemUp(), produto());

    const [ev] = eventos(logSpy, "ml.up.title.compare");
    expect(ev).toMatchObject({
      event: "ml.up.title.compare",
      productId: "prod-1",
      externalListingId: "MLB7319051094",
      decision: "skip",
      reason: "exact",
    });
    const todoLog = [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map(String)
      .join(" ");
    expect(todoLog).not.toContain("tok-secreto");
  });

  it("pula mesmo quando o family_name remoto está vazio (só o title derivado)", async () => {
    await rodar(itemUp({ family_name: "" }), produto());

    expect(republishSpy).not.toHaveBeenCalled();
    const [ev] = eventos(logSpy, "ml.up.title.compare");
    expect(ev.reason).toBe("remote_contains_desired");
  });

  it("renomeação de verdade republica, e com o título SANITIZADO (não o cru)", async () => {
    await rodar(
      itemUp({
        family_name: "Farol Dianteiro Direito Palio 2015",
        title: "Farol Dianteiro Direito Palio 2015",
      }),
      produto({ name: "PORTA TRASEIRA ESQUERDA GOL G5 2010/2012 (ORIGINAL)" }),
    );

    expect(republishSpy).toHaveBeenCalledTimes(1);
    const args = republishSpy.mock.calls[0][0] as { newTitle: string };
    expect(args.newTitle).toBe("PORTA TRASEIRA ESQUERDA GOL G5 2010 2012 ORIGINAL");
    expect(eventos(warnSpy, "ml.up.title.compare")[0]).toMatchObject({
      decision: "republish",
      reason: "different",
    });
  });

  it("CONVERGE: a segunda passada sobre o anúncio recém-republicado não republica de novo", async () => {
    const novoNome = "PORTA TRASEIRA ESQUERDA GOL G5 2010/2012 (ORIGINAL)";
    const publicado = "PORTA TRASEIRA ESQUERDA GOL G5 2010 2012 ORIGINAL";
    // Como o ML devolve o family_name Title-Case-ado do que foi publicado:
    const familyNameDoNovo = "Porta Traseira Esquerda Gol G5 2010 2012 Original";
    expect(familyNameDoNovo.toUpperCase()).toBe(publicado.toUpperCase());

    await rodar(
      itemUp({
        family_name: familyNameDoNovo,
        title: `${familyNameDoNovo} Traseira Esquerda Prata`,
      }),
      produto({ name: novoNome }),
    );

    expect(republishSpy).not.toHaveBeenCalled();
  });

  it("diferença não material (reordenação) não republica", async () => {
    await rodar(
      itemUp({
        family_name: "Dolphin Byd Porta Dianteira Direita Plus 2024 2025 2026",
        title: "Dolphin Byd Porta Dianteira Direita Plus 2024 2025 2026",
      }),
      produto(),
    );

    expect(republishSpy).not.toHaveBeenCalled();
    expect(eventos(logSpy, "ml.up.title.compare")[0]).toMatchObject({
      decision: "skip",
      reason: "not_material",
    });
  });

  it("salvaguarda preservada: item UP com vendas não republica nem com renomeação real", async () => {
    await rodar(
      itemUp({
        family_name: "Farol Dianteiro Direito Palio 2015",
        title: "Farol Dianteiro Direito Palio 2015",
        sold_quantity: 3,
      }),
      produto({ name: "PORTA TRASEIRA ESQUERDA GOL G5" }),
    );

    expect(republishSpy).not.toHaveBeenCalled();
    expect(eventos(warnSpy, "ml.up.republish.skipped")[0]).toMatchObject({
      reason: "item_has_sales_or_bids",
      soldQty: 3,
    });
  });

  it("kill-switch ML_UP_TITLE_COMPARE_DISABLED restaura a comparação crua (volta a republicar)", async () => {
    process.env.ML_UP_TITLE_COMPARE_DISABLED = "1";

    await rodar(itemUp(), produto());

    expect(republishSpy).toHaveBeenCalledTimes(1);
    const args = republishSpy.mock.calls[0][0] as { newTitle: string };
    // No caminho antigo ia o nome CRU.
    expect(args.newTitle).toBe(NOME_PRODUTO);
  });
});

describe("SyncUseCase.syncMLProductData → item NÃO-UP segue inalterado", () => {
  beforeEach(() => {
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    vi.spyOn(prisma.productListing, "findFirst").mockResolvedValue(null as any);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const itemLegado = {
    id: "MLB-legado",
    status: "active",
    available_quantity: 1,
    price: 100,
    title: "Farol Dianteiro Direito Gol",
    sold_quantity: 0,
    has_bids: false,
  };

  it("propaga o título CRU mesmo quando a diferença é só de caixa", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(
      itemLegado as any,
    );
    const updateSpy = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue(itemLegado as any);
    const republishSpy = vi.spyOn(SyncUseCase, "republishUpListing");

    await (SyncUseCase as any).syncMLProductData(
      produto({ name: "FAROL DIANTEIRO DIREITO GOL", price: 100 }),
      "MLB-legado",
      ACCOUNT,
    );

    expect(republishSpy).not.toHaveBeenCalled();
    const body = updateSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(body.title).toBe("FAROL DIANTEIRO DIREITO GOL");
  });
});
