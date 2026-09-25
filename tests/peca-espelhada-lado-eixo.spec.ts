import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "@prisma/client";

// Mesmo stub do order.usecase.spec.ts: deductStockForOrder dispara um
// setImmediate pos-commit que chamaria o prisma real.
vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import {
  titleSimilarity,
  areTitlesSimilar,
  titleSide,
  titleAxis,
  isOppositeSideOrAxis,
  oppositionReason,
} from "@/app/lib/title-similarity";
import prisma from "@/app/lib/prisma";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { orderRepository } from "@/app/repositories/order.repository";
import { ListingRepository } from "@/app/marketplaces/repositories/listing.repository";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import {
  ListingAutodetectUseCase,
  NormalizedMarketplaceItem,
} from "@/app/marketplaces/usecases/listing-autodetect.usercase";

/**
 * PECA ESPELHADA: lado e eixo sao excludentes, e o Jaccard nao ve.
 *
 * `titleTokens` descarta tokens de 1 caractere, entao a notacao compacta do ramo
 * (`L/e`, `L/d`, `T/e`, `T/d`) desaparece por inteiro e dois titulos que so
 * diferem no LADO ficam identicos — semelhanca 1,00.
 *
 * Medido em producao (15/09/2026) sobre 292.014 pares anuncio x produto de 9
 * clientes: 758 vinculos tem lado ou eixo OPOSTO, e 485 deles (0,166%) hoje sao
 * aprovados pelo Jaccard — invisiveis para a guarda de titulo.
 */

const ESQ = "Amortecedor Tampa Do Porta Malas L/e Volkswagen Gol 2021";
const DIR = "Amortecedor Tampa Do Porta Malas L/d Volkswagen Gol 2021";

describe("a causa: o tokenizador apagava o lado (corrigido, mas nao basta)", () => {
  it("L/e x L/d ja NAO da mais 1,00 — o tokenizador canoniza o lado", () => {
    // Antes da canonizacao, `L/e` e `L/d` viravam tokens de 1 caractere e eram
    // descartados: os dois titulos ficavam IDENTICOS (1,00). Hoje cada um
    // carrega seu sentinela (`esq` / `dir`) e a semelhanca fica honesta.
    expect(titleSimilarity(ESQ, DIR)).toBeLessThan(1);
    expect(titleSimilarity(ESQ, DIR)).toBeCloseTo(0.78, 2);
  });

  it("⚠️ mas 0,78 ainda passa no limiar de 0,4 — por isso a guarda de lado continua necessaria", () => {
    // Este e o ponto: canonizar torna o NUMERO honesto, nao o VEREDITO seguro.
    // O lado e 1 token entre 8; nenhum limiar razoavel separa peca espelhada
    // de peca reanunciada. Quem separa e `isOppositeSideOrAxis`.
    expect(areTitlesSimilar(ESQ, DIR)).toBe(true);
    expect(isOppositeSideOrAxis(ESQ, DIR)).toBe(true);
  });

  it("e a MESMA peca escrita de dois jeitos ficou mais proxima", () => {
    // O outro lado da moeda da canonizacao, e o ganho maior: 274 pares reais
    // passaram a ser reconhecidos como a mesma peca.
    const porExtenso = "Chicote Porta Dianteira Esquerda Gm Onix 1.4 2017";
    const abreviado = "Chicote Porta Diant Esq Gm Onix 1.4 2017";
    expect(areTitlesSimilar(porExtenso, abreviado)).toBe(true);
    expect(titleSimilarity(porExtenso, abreviado)).toBeGreaterThan(0.9);
  });

  it("genero e abreviacao caem no MESMO sentinela", () => {
    // "Traseira Direita" x "Traseira L/D" caia de 0,42 para 0,38 quando o alvo
    // era a palavra por extenso ("direito" != "direita"). Com sentinela, nao.
    expect(
      areTitlesSimilar(
        "Acabamento Coluna Traseira Direita Corsa Hatch",
        "Acabamento Coluna Traseira L/D Corsa Hatch",
      ),
    ).toBe(true);
    expect(
      titleSimilarity("Lanterna Traseira Esq Corsa", "Lanterna Traseira L/E Corsa"),
    ).toBe(1);
  });

  it("⚠️⚠️ a preposicao 'de' NAO pode virar lado/eixo", () => {
    // Com separador opcional, /\bd[/.\-]?e\b/ casa com "de" e reescreve
    // "Ponta DE Eixo Traseiro" como "Ponta diant esq Eixo Traseiro".
    // Seria corrupcao silenciosa de metade do catalogo.
    expect(
      titleSimilarity(
        "Ponta Eixo Traseiro Volkswagen Gol 1997",
        "Ponta De Eixo Traseiro Vw Gol 1997",
      ),
    ).toBeGreaterThan(0.6);
    expect(titleSide("Ponta De Eixo Traseiro Gol")).toBeNull();
  });

  it("escrito por extenso o Jaccard tambem aprova, porque o lado e 1 token entre 7", () => {
    const a = "Pinca Freio Dianteira Esquerda Gol G5 G6 Saveiro";
    const b = "Pinca Freio Dianteira Direita Gol G5 G6 Saveiro";
    expect(areTitlesSimilar(a, b)).toBe(true);
    expect(titleSimilarity(a, b)).toBeGreaterThan(0.7);
  });
});

describe("titleSide / titleAxis", () => {
  it("le o lado por extenso e nas formas compactas do ramo", () => {
    expect(titleSide("Farol Esquerdo Gol G4")).toBe("E");
    expect(titleSide("Farol Direito Gol G4")).toBe("D");
    expect(titleSide("Macaneta Externa Diant L/e Ford Fiesta")).toBe("E");
    expect(titleSide("Macaneta Externa Diant L/d Ford Fiesta")).toBe("D");
    expect(titleSide("Lanterna T.E. Gol G4")).toBe("E");
    expect(titleSide("Lanterna T.D. Gol G4")).toBe("D");
  });

  it("⚠️ a borda de palavra segura o 'le' de 'Lente'", () => {
    // Sem `\b`, /[ltd][/.\-]e/ casaria dentro de "Lente" e o titulo inteiro
    // viraria "lado esquerdo".
    expect(titleSide("Lente Do Farol Gol G4")).toBeNull();
    expect(titleSide("Cilindro Mestre Etios")).toBeNull();
  });

  it("⚠️⚠️ a preposicao 'de' NAO e lado esquerdo", () => {
    // Com o separador opcional, /\b[ltd][/.\s-]?e\b/ casava com "de" e QUALQUER
    // titulo que a contivesse virava lado esquerdo. Bastava o outro lado do par
    // dizer "direita" para a guarda acusar oposicao inexistente.
    expect(titleSide("Ponta De Eixo Traseiro Volkswagen Gol 1997")).toBeNull();
    expect(titleSide("Caixa De Direcao Fiat Mobi 2017")).toBeNull();
    expect(titleSide("Bomba De Combustivel Ford Fiesta")).toBeNull();
    // E o par que isso teria quebrado:
    expect(
      isOppositeSideOrAxis(
        "Ponta De Eixo Traseiro Vw Gol 1997",
        "Ponta Eixo Traseiro Direito Vw Gol 1997",
      ),
    ).toBe(false);
  });

  it("le as formas compactas COM separador, e as nuas inequivocas", () => {
    expect(titleSide("Farol L/e Gol")).toBe("E");
    expect(titleSide("Farol L.D Gol")).toBe("D");
    expect(titleSide("Lanterna T-E Gol")).toBe("E");
    expect(titleSide("Moldura Interruptor Duplo Le Strada")).toBe("E");
    expect(titleSide("Acabamento Coluna Ld Corolla")).toBe("D");
  });

  it("devolve null quando o titulo declara os DOIS lados", () => {
    expect(titleSide("Par Lanterna Esquerda E Direita Gol")).toBeNull();
    expect(titleAxis("Kit Pastilha Dianteira E Traseira Onix")).toBeNull();
  });

  it("le o eixo, singular e plural", () => {
    expect(titleAxis("Pastilha Dianteira Onix")).toBe("DIANT");
    expect(titleAxis("Amortecedores Traseiros Onix")).toBe("TRAS");
    expect(titleAxis("Bomba De Agua Onix")).toBeNull();
  });
});

describe("isOppositeSideOrAxis", () => {
  it("nome ausente (caminho antigo, anterior ao #347) nao explode e nao acusa", () => {
    // Desde o #347 o produto casado vem SEMPRE com `name` (select { id, name });
    // a guarda continua muda se um chamador antigo passar sem ele.
    expect(isOppositeSideOrAxis(ESQ, undefined as never)).toBe(false);
    expect(isOppositeSideOrAxis(ESQ, null as never)).toBe(false);
  });

  it("acusa os casos reais que estavam passando", () => {
    expect(isOppositeSideOrAxis(ESQ, DIR)).toBe(true);
    expect(
      isOppositeSideOrAxis(
        "Suporte Esquerdo Tampao Ford Ka 1.0/2008",
        "Suporte Direito Tampao Ford Ka 1.0/2008",
      ),
    ).toBe(true);
    expect(
      isOppositeSideOrAxis(
        "Botao Vidro Eletrico Dianteiro Direito Honda Civic 99",
        "Botao Vidro Eletrico Traseiro Direito Honda Civic 99",
      ),
    ).toBe(true);
    expect(
      isOppositeSideOrAxis(
        "Chicote Da Porta Dianteira Esquerda Vw Polo Virtus",
        "Chicote Da Porta Traseira Direita Vw Polo Virtus",
      ),
    ).toBe(true);
  });

  it("silencio NAO e evidencia: um declara o lado, o outro nao", () => {
    expect(isOppositeSideOrAxis("Farol Esquerdo Gol G4", "Farol Gol G4")).toBe(
      false,
    );
    expect(isOppositeSideOrAxis("Retrovisor Hb20", "Retrovisor Direito Hb20")).toBe(
      false,
    );
  });

  it("NAO acusa quando lado e eixo coincidem, mesmo com grafia diferente", () => {
    expect(
      isOppositeSideOrAxis(
        "Retrovisor Eletrico Lado Direito Hb20",
        "Retrovisor Eletrico Direito Hb20",
      ),
    ).toBe(false);
    expect(
      isOppositeSideOrAxis(
        "Vidro Porta Traseira Esquerda Onix",
        "Vidro Porta Traseira Esquerda Onix 2016",
      ),
    ).toBe(false);
  });

  it("NAO acusa pecas diferentes que nao divergem por lado — isso e trabalho do Jaccard", () => {
    expect(
      isOppositeSideOrAxis("Pedal De Freio Celta", "Pedal De Embreagem Celta"),
    ).toBe(false);
  });

  it("oppositionReason descreve o motivo para o log", () => {
    expect(oppositionReason(ESQ, DIR)).toBe("lado ExD");
    expect(
      oppositionReason(
        "Chicote Da Porta Dianteira Esquerda Vw Polo",
        "Chicote Da Porta Traseira Direita Vw Polo",
      ),
    ).toBe("lado ExD + eixo DIANTxTRAS");
    expect(oppositionReason("Farol Esquerdo Gol", "Farol Gol")).toBe("");
  });
});

// ---------------------------------------------------------------------------

const pedido = (sellerSku: string | null, titulo: string) => ({
  id: 4242,
  status: "paid",
  total_amount: 100,
  buyer: { first_name: "Jo", last_name: "Silva", nickname: "jo" },
  order_items: [
    {
      quantity: 1,
      unit_price: 100,
      item: {
        id: "MLB-ESPELHADA",
        title: titulo,
        seller_custom_field: sellerSku,
        seller_sku: null,
      },
    },
  ],
});

describe("caminho do pedido: nao baixar o lado errado", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("RECUSA baixar quando o SKU casa mas o anuncio e o lado OPOSTO do produto", async () => {
    vi.spyOn(orderRepository, "exists").mockResolvedValue(false);
    vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue(null);
    // SKU unico e titulo "semelhante" (1,00 pelo Jaccard) — a guarda antiga
    // aprovava. So a oposicao de lado separa.
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-lado-direito", name: DIR },
    ] as never);
    const upsert = vi
      .spyOn(ListingRepository, "upsertFromOrderFallback")
      .mockResolvedValue({ id: "listing-x" } as never);
    const criar = vi.spyOn(orderRepository, "create");

    const r = await (
      OrderUseCase as never as {
        processOrder: (...a: unknown[]) => Promise<{ status?: string }>;
      }
    ).processOrder(pedido("7788", ESQ), "acc-1", true, undefined, "user-1");

    // Nada vinculado, nada gravado: melhor nao baixar do que baixar o lado errado.
    expect(upsert).not.toHaveBeenCalled();
    expect(criar).not.toHaveBeenCalled();
    expect(r.status).toBe("no_products");
  });

  it("SEM REGRESSAO: mesmo lado segue vinculando e baixando normalmente", async () => {
    vi.spyOn(orderRepository, "exists").mockResolvedValue(false);
    vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue(null);
    vi.spyOn(prisma.product, "findMany").mockResolvedValue([
      { id: "prod-lado-esquerdo", name: ESQ },
    ] as never);
    const upsert = vi
      .spyOn(ListingRepository, "upsertFromOrderFallback")
      .mockResolvedValue({ id: "listing-ok" } as never);
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "ord-1",
      items: [{ productId: "prod-lado-esquerdo", quantity: 1 }],
    } as never);
    vi.spyOn(
      OrderUseCase as never as { deductStockForOrder: unknown },
      "deductStockForOrder" as never,
    ).mockResolvedValue([] as never);

    await (
      OrderUseCase as never as {
        processOrder: (...a: unknown[]) => Promise<unknown>;
      }
    ).processOrder(pedido("7788", ESQ), "acc-1", true, undefined, "user-1");

    expect(upsert).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

const anuncio = (
  over: Partial<NormalizedMarketplaceItem> = {},
): NormalizedMarketplaceItem => ({
  platform: Platform.MERCADO_LIVRE,
  account: { id: "acc1", userId: "u1" },
  externalListingId: "MLB999",
  rawSku: "7788",
  title: ESQ,
  price: 120,
  stock: 1,
  status: "active",
  permalink: "http://ml/MLB999",
  imageUrl: "http://img/1.jpg",
  createdAt: new Date("2026-09-15T00:00:00Z"),
  ...over,
});

describe("autodeteccao: peca espelhada ganha produto proprio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("NAO vincula o anuncio do lado esquerdo ao produto do lado direito", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "p-lado-direito",
      name: DIR,
    } as never);
    // O produto casado NAO tem anuncio nesta conta: a guarda de box-label
    // (que exige isso) nao dispararia. So a de lado pega.
    vi.spyOn(ListingRepository, "productHasListingInAccount").mockResolvedValue(
      false as never,
    );
    const create = vi
      .spyOn(ProductUseCase.prototype, "create")
      .mockResolvedValue({ id: "p-novo" } as never);
    const upsert = vi
      .spyOn(ListingRepository, "upsertAutodetectedListing")
      .mockResolvedValue({ id: "l1", productId: "p-novo" } as never);

    const res =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(anuncio());

    expect(res.action).toBe("created_product");
    expect(res.productId).toBe("p-novo");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p-novo" }),
    );
    // SKU sintetico: nao pode reocupar o "7788" do produto do outro lado.
    expect(create).toHaveBeenCalled();
    const sku = (create.mock.calls[0]?.[0] as { sku?: string } | undefined)?.sku;
    expect(sku).not.toBe("7788");
  });

  it("SEM REGRESSAO: mesmo lado continua agrupando no produto existente", async () => {
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "p-lado-esquerdo",
      name: ESQ,
    } as never);
    vi.spyOn(ListingRepository, "productHasListingInAccount").mockResolvedValue(
      false as never,
    );
    const create = vi.spyOn(ProductUseCase.prototype, "create");
    vi.spyOn(ListingRepository, "upsertAutodetectedListing").mockResolvedValue({
      id: "l1",
      productId: "p-lado-esquerdo",
    } as never);

    const res =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(anuncio());

    expect(res).toEqual({
      action: "linked_existing_product",
      productId: "p-lado-esquerdo",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("SEM REGRESSAO: produto do MESMO lado continua sendo ligado (a guarda fica muda)", async () => {
    // Era "produto sem nome": caminhos antigos passavam `matched` sem `name`. Desde o
    // #347 (18/09) o produto casado vem SEMPRE com `name` (findProductBySku faz
    // select { id, name }), e nome ausente conta como título incompatível — o
    // anúncio ganha ficha própria, de propósito. O caso real equivalente é o do
    // mesmo lado: a guarda de peça espelhada tem de ficar muda e o vínculo sai.
    // (Nome ausente na própria guarda: coberto em "isOppositeSideOrAxis".)
    vi.spyOn(
      ListingRepository,
      "findProductIdByExternalListingId",
    ).mockResolvedValue(null);
    vi.spyOn(prisma.product, "findFirst").mockResolvedValue({
      id: "p-sem-nome",
      name: ESQ,
    } as never);
    vi.spyOn(ListingRepository, "productHasListingInAccount").mockResolvedValue(
      false as never,
    );
    vi.spyOn(ListingRepository, "upsertAutodetectedListing").mockResolvedValue({
      id: "l1",
      productId: "p-sem-nome",
    } as never);

    const res =
      await ListingAutodetectUseCase.upsertProductFromMarketplaceItem(anuncio());

    expect(res).toEqual({
      action: "linked_existing_product",
      productId: "p-sem-nome",
    });
  });
});
