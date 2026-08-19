import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O filtro "Categoria publicada" da tela de Produtos.
 *
 * TERCEIRA tela com o mesmo sintoma. O branch já corrigiu o número cru da OLX e
 * o caminho em inglês do Facebook no modal de cadastro e na sugestão — e aqui o
 * combobox seguia oferecendo "OLX • 2101" e "Facebook • Vehicles & Parts >
 * Vehicle Parts & Accessories > Motor Vehicle Parts". O operador não sabe o que
 * está filtrando.
 *
 * A causa é estrutural: ML e Shopee têm linha na tabela `Category`, de onde sai
 * o nome; OLX e Facebook têm o de-para curado no código, então caíam direto no
 * `rawCategoryId`.
 *
 * ⚠️ Só o LABEL muda. O `value` é o par plataforma+código que vai para a query —
 * traduzi-lo quebraria o filtro. Os casos abaixo travam as duas metades.
 */

vi.mock("../app/lib/prisma", () => ({
  default: {
    productListing: { findMany: vi.fn() },
    marketplaceCategory: { findMany: vi.fn() },
  },
}));

import prisma from "../app/lib/prisma";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

const MOTOR_VEHICLE_PARTS =
  "Vehicles & Parts > Vehicle Parts & Accessories > Motor Vehicle Parts";

function vinculo(platform: string, requestedCategoryId: string) {
  return {
    marketplaceAccountId: `acc-${platform}`,
    requestedCategoryId,
    marketplaceAccount: { platform },
  };
}

describe("filtro 'Categoria publicada' — nome legível também na OLX e no Facebook", () => {
  const repo = new ProductRepositoryPrisma();

  beforeEach(() => {
    vi.clearAllMocks();
    // Nenhuma linha na tabela de categorias: é a situação real de OLX e Facebook.
    (prisma as any).marketplaceCategory.findMany.mockResolvedValue([]);
  });

  it("OLX aparece com o nome da categoria, não com o código 2101", async () => {
    (prisma as any).productListing.findMany.mockResolvedValue([
      vinculo("OLX", "2101"),
    ]);

    const [opcao] = await repo.findPublishedCategories("user-1");

    expect(opcao.label).toBe("OLX • Carros, vans e utilitários");
    expect(opcao.label).not.toContain("2101");
  });

  it("Facebook aparece em português, não com a taxonomia do Google", async () => {
    (prisma as any).productListing.findMany.mockResolvedValue([
      vinculo("FACEBOOK", MOTOR_VEHICLE_PARTS),
    ]);

    const [opcao] = await repo.findPublishedCategories("user-1");

    expect(opcao.label).toBe("Facebook • Peças de carros, vans e utilitários");
    expect(opcao.label.toLowerCase()).not.toContain("vehicle");
  });

  it("o VALOR que vai para a query continua sendo o código — só o rótulo mudou", async () => {
    (prisma as any).productListing.findMany.mockResolvedValue([
      vinculo("OLX", "2103"),
      vinculo("FACEBOOK", MOTOR_VEHICLE_PARTS),
    ]);

    const opcoes = await repo.findPublishedCategories("user-1");

    const olx = opcoes.find((o) => o.platform === "OLX")!;
    const fb = opcoes.find((o) => o.platform === "FACEBOOK")!;

    expect(olx.categoryId).toBe("2103");
    expect(olx.value).toContain("2103");
    expect(fb.categoryId).toBe(MOTOR_VEHICLE_PARTS);
    expect(fb.value).toContain("Motor Vehicle Parts");
  });

  it("código desconhecido degrada para o valor cru, em vez de sumir da lista", async () => {
    // Controle negativo do fallback: se um dia a OLX criar uma categoria nova, a
    // opção ainda tem que aparecer — feia, mas presente.
    (prisma as any).productListing.findMany.mockResolvedValue([
      vinculo("OLX", "9999"),
    ]);

    const [opcao] = await repo.findPublishedCategories("user-1");

    expect(opcao).toBeDefined();
    expect(opcao.label).toBe("OLX • 9999");
  });

  it("ML e Shopee seguem saindo da tabela Category, exatamente como antes", async () => {
    // Controle de regressão: os rótulos curados não podem sequestrar os canais
    // que já funcionavam.
    (prisma as any).productListing.findMany.mockResolvedValue([
      vinculo("MERCADO_LIVRE", "MLB1744"),
    ]);
    (prisma as any).marketplaceCategory.findMany.mockResolvedValue([
      {
        externalId: "MLB1744",
        fullPath: "Acessórios para Veículos > Peças",
        name: "Peças",
      },
    ]);

    const [opcao] = await repo.findPublishedCategories("user-1");

    expect(opcao.label).toBe(
      "Mercado Livre • Acessórios para Veículos > Peças",
    );
  });
});
