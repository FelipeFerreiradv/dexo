import { describe, it, expect, vi, afterEach } from "vitest";

import prisma from "@/app/lib/prisma";
import { ProductRepositoryPrisma } from "@/app/repositories/product.repository";

const productRepository = new ProductRepositoryPrisma();

// ──────────────────────────────────────────────────────────────────────────
// Protege o fluxo de CRIAR/EDITAR produto do índice único novo sobre
// (userId, skuNormalized) — ver docs/dedupe-sku-sql.md.
//
// O Prisma entrega `meta.target` de DUAS formas: array de campos (constraints
// do schema) e STRING com o nome do índice (constraints criadas por SQL, que
// ele não conhece). Um `target.includes("sku")` cru acerta a primeira e erra a
// segunda — e o erro vazaria CRU para a tela do usuário.
// ──────────────────────────────────────────────────────────────────────────

function p2002(target: string[] | string) {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("conflito de SKU vira mensagem acionável (criar e editar)", () => {
  it("EDITAR: índice do skuNormalized (target STRING) → mensagem clara, não erro cru", async () => {
    vi.spyOn(prisma, "$transaction").mockRejectedValue(
      p2002("Product_userId_skuNormalized_key"),
    );

    await expect(
      productRepository.update("p1", { sku: "Mk2-204" } as any, "u1"),
    ).rejects.toThrow("Produto com esse sku já existe");
  });

  it("EDITAR: unique do sku cru (target ARRAY) → mesma mensagem", async () => {
    vi.spyOn(prisma, "$transaction").mockRejectedValue(
      p2002(["userId", "sku"]),
    );

    await expect(
      productRepository.update("p1", { sku: "mk2-204" } as any, "u1"),
    ).rejects.toThrow("Produto com esse sku já existe");
  });

  it("EDITAR: erro que NÃO é de SKU continua propagando como antes", async () => {
    vi.spyOn(prisma, "$transaction").mockRejectedValue(
      new Error("connection refused"),
    );

    await expect(
      productRepository.update("p1", { name: "x" } as any, "u1"),
    ).rejects.toThrow("connection refused");
  });

  it("EDITAR: P2002 de OUTRO campo (ex.: partNumber) não vira mensagem de SKU", async () => {
    vi.spyOn(prisma, "$transaction").mockRejectedValue(
      p2002(["userId", "partNumber"]),
    );

    await expect(
      productRepository.update("p1", { name: "x" } as any, "u1"),
    ).rejects.not.toThrow("Produto com esse sku já existe");
  });
});
