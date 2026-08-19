import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform, AccountStatus } from "@prisma/client";

// ──────────────────────────────────────────────────────────
// BLOCO G na OLX e no Facebook — a sombra de estoque disponível no PUBLISH.
//
// A main aplicou `withAvailableStock` em cinco pontos. Três são por plataforma
// (`createMLListing`, `createMagaluListing`, `createShopeeListing`) e foram
// escritos quando OLX e Facebook ainda não existiam — então os dois canais
// novos publicavam com o estoque BRUTO. Anunciar peça que já está numa venda em
// aberto é criar a venda dupla no ato do cadastro, e só nesses dois canais.
//
// ⚠️ POR QUE ESTE SPEC EXISTE, se `stock-reservation-cobertura.spec.ts` já
// cobre o assunto: aquele testa o HELPER puro (idempotência, contrato, flag).
// Ele provaria a mesma coisa com os cinco creates ignorando a sombra. Aqui o
// que se prova é o COMPORTAMENTO dos dois caminhos — que a peça comprometida é
// de fato recusada na publicação.
//
// O controle negativo é o que dá valor ao caso: com a flag DESLIGADA o mesmo
// produto TEM de passar da guarda de estoque e morrer na de preço. Sem isso,
// um `return` acidental antes da guarda faria o teste passar por engano.
// ──────────────────────────────────────────────────────────

import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";

const USER_ID = "user-1";
const PRODUCT_ID = "prod-1";
const ACCOUNT_ID = "acc-1";

/**
 * Peça inteiramente comprometida: 3 em estoque, 3 presos numa venda em aberto.
 * Disponível = 0.
 *
 * `price: 0` é deliberado — é o marcador do controle negativo. Com a reserva
 * desligada o fluxo passa da guarda de estoque e para na de preço, e é assim
 * que se distingue "a sombra agiu" de "o método recusou por outro motivo".
 */
const PRODUTO_TODO_RESERVADO = {
  id: PRODUCT_ID,
  sku: "FAROL-001",
  name: "Farol Direito",
  stock: 3,
  reservedStock: 3,
  price: 0,
};

function mockarContaEProduto(platform: Platform) {
  vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue({
    id: ACCOUNT_ID,
    userId: USER_ID,
    platform,
    status: AccountStatus.ACTIVE,
    accessToken: "token-valido",
  } as any);
  // `productRepository` é privado na classe; o spy precisa do cast, senão o
  // `tsc` reprova o spec (TS2341) mesmo com o teste verde.
  vi.spyOn(
    (ListingUseCase as any).productRepository,
    "findById",
  ).mockResolvedValue(PRODUTO_TODO_RESERVADO as any);
}

/** Liga/desliga a flag de backend restaurando o valor anterior. */
function comReserva<T>(ligada: boolean, fn: () => Promise<T>): Promise<T> {
  const anterior = process.env.STOCK_RESERVATION_ENABLED;
  if (ligada) process.env.STOCK_RESERVATION_ENABLED = "1";
  else delete process.env.STOCK_RESERVATION_ENABLED;
  return fn().finally(() => {
    if (anterior === undefined) delete process.env.STOCK_RESERVATION_ENABLED;
    else process.env.STOCK_RESERVATION_ENABLED = anterior;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OLX — publicar peça comprometida por venda em aberto", () => {
  it("com a reserva LIGADA, recusa por estoque", async () => {
    mockarContaEProduto(Platform.OLX);

    const r = await comReserva(true, () =>
      ListingUseCase.createOlxListing(
        USER_ID,
        PRODUCT_ID,
        undefined,
        ACCOUNT_ID,
      ),
    );

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/estoque maior que zero/i);
  });

  it("CONTROLE NEGATIVO: com a reserva DESLIGADA, passa da guarda de estoque", async () => {
    mockarContaEProduto(Platform.OLX);

    const r = await comReserva(false, () =>
      ListingUseCase.createOlxListing(
        USER_ID,
        PRODUCT_ID,
        undefined,
        ACCOUNT_ID,
      ),
    );

    expect(r.success).toBe(false);
    // Chegou na guarda SEGUINTE — prova que os 3 brutos foram aceitos e que o
    // caso acima falhou pela sombra, não por outro motivo qualquer.
    expect(r.error).toMatch(/preço maior que zero/i);
    expect(r.error).not.toMatch(/estoque/i);
  });
});

describe("Facebook — publicar peça comprometida por venda em aberto", () => {
  it("com a reserva LIGADA, recusa por estoque", async () => {
    mockarContaEProduto(Platform.FACEBOOK);

    const r = await comReserva(true, () =>
      ListingUseCase.createFacebookListing(
        USER_ID,
        PRODUCT_ID,
        undefined,
        ACCOUNT_ID,
      ),
    );

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/estoque maior que zero/i);
  });

  it("CONTROLE NEGATIVO: com a reserva DESLIGADA, passa da guarda de estoque", async () => {
    mockarContaEProduto(Platform.FACEBOOK);

    const r = await comReserva(false, () =>
      ListingUseCase.createFacebookListing(
        USER_ID,
        PRODUCT_ID,
        undefined,
        ACCOUNT_ID,
      ),
    );

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/preço maior que zero/i);
    expect(r.error).not.toMatch(/estoque/i);
  });
});

describe("Peça PARCIALMENTE comprometida continua publicável", () => {
  // A sombra não pode virar um bloqueio geral: 5 em estoque com 2 presos ainda
  // tem 3 vendáveis, e recusar aí seria uma regressão pior que o bug original.
  const PARCIAL = { ...PRODUTO_TODO_RESERVADO, stock: 5, reservedStock: 2 };

  it("OLX: passa da guarda de estoque com 3 disponíveis", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue({
      id: ACCOUNT_ID,
      userId: USER_ID,
      platform: Platform.OLX,
      status: AccountStatus.ACTIVE,
      accessToken: "token-valido",
    } as any);
    // `productRepository` é privado na classe; o spy precisa do cast, senão o
    // `tsc` reprova o spec (TS2341) mesmo com o teste verde.
    vi.spyOn(
      (ListingUseCase as any).productRepository,
      "findById",
    ).mockResolvedValue(PARCIAL as any);

    const r = await comReserva(true, () =>
      ListingUseCase.createOlxListing(
        USER_ID,
        PRODUCT_ID,
        undefined,
        ACCOUNT_ID,
      ),
    );

    expect(r.error).toMatch(/preço maior que zero/i);
    expect(r.error).not.toMatch(/estoque/i);
  });
});
