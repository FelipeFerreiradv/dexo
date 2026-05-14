import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

import { productRoutes } from "@/app/routes/product.routes";
import { ProductUseCase } from "@/app/usecases/product.usercase";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";
import { SystemLogService } from "@/app/services/system-log.service";

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(productRoutes, { prefix: "/products" });
  return app;
};

const FAKE_USER = { id: "user-1", email: "u@x.com" };

describe("PATCH /products/:id/listings-status", () => {
  beforeEach(() => {
    // Auth middleware busca user pelo email do header
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      FAKE_USER as any,
    );
    // Silencia logs (fire-and-forget — não queremos que o teste dependa de DB)
    vi.spyOn(SystemLogService, "logInfo").mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("200 OK + listingResults quando usecase reporta sucesso", async () => {
    const spyPause = vi
      .spyOn(ProductUseCase.prototype, "pauseListings")
      .mockResolvedValue({
        success: true,
        message: "2 anúncio(s) pausado(s).",
        listingResults: [
          {
            externalListingId: "MLB1",
            platform: "MERCADO_LIVRE" as any,
            paused: true,
            alreadyInState: false,
          },
          {
            externalListingId: "555",
            platform: "SHOPEE" as any,
            paused: true,
            alreadyInState: false,
          },
        ],
      });

    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/products/prod-1/listings-status",
      headers: { email: "u@x.com" },
      payload: { status: "paused" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/2 anúncio/);
    expect(body.listingResults).toHaveLength(2);
    expect(spyPause).toHaveBeenCalledWith("prod-1", "user-1", "paused");
    await app.close();
  });

  it("400 quando status nao eh 'active' nem 'paused'", async () => {
    const spyPause = vi.spyOn(ProductUseCase.prototype, "pauseListings");

    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/products/prod-1/listings-status",
      headers: { email: "u@x.com" },
      payload: { status: "foo" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Status inválido/);
    expect(spyPause).not.toHaveBeenCalled();
    await app.close();
  });

  it("400 quando body nao tem status", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/products/prod-1/listings-status",
      headers: { email: "u@x.com" },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404 quando produto nao existe ou nao pertence ao usuario", async () => {
    vi.spyOn(ProductUseCase.prototype, "pauseListings").mockResolvedValue({
      success: false,
      message: "Produto não encontrado",
      listingResults: [],
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/products/prod-X/listings-status",
      headers: { email: "u@x.com" },
      payload: { status: "paused" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/não encontrado/);
    await app.close();
  });

  it("401 quando email do header eh ausente (auth middleware)", async () => {
    const spyPause = vi.spyOn(ProductUseCase.prototype, "pauseListings");

    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/products/prod-1/listings-status",
      payload: { status: "paused" },
    });

    expect(res.statusCode).toBe(401);
    expect(spyPause).not.toHaveBeenCalled();
    await app.close();
  });

  it("500 quando TODOS os listings falham (success=false sem 'nao encontrado')", async () => {
    vi.spyOn(ProductUseCase.prototype, "pauseListings").mockResolvedValue({
      success: false,
      message: "Nenhum anúncio foi alterado: 2 falha(s).",
      listingResults: [
        {
          externalListingId: "MLB1",
          platform: "MERCADO_LIVRE" as any,
          paused: false,
          alreadyInState: false,
          error: "boom1",
        },
        {
          externalListingId: "555",
          platform: "SHOPEE" as any,
          paused: false,
          alreadyInState: false,
          error: "boom2",
        },
      ],
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/products/prod-1/listings-status",
      headers: { email: "u@x.com" },
      payload: { status: "paused" },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.listingResults).toHaveLength(2);
    await app.close();
  });

  it("aceita 'active' (despausar) com 200 + listingResults", async () => {
    const spyPause = vi
      .spyOn(ProductUseCase.prototype, "pauseListings")
      .mockResolvedValue({
        success: true,
        message: "1 anúncio(s) reativado(s).",
        listingResults: [
          {
            externalListingId: "MLB1",
            platform: "MERCADO_LIVRE" as any,
            paused: true,
            alreadyInState: false,
          },
        ],
      });

    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/products/prod-1/listings-status",
      headers: { email: "u@x.com" },
      payload: { status: "active" },
    });

    expect(res.statusCode).toBe(200);
    expect(spyPause).toHaveBeenCalledWith("prod-1", "user-1", "active");
    await app.close();
  });
});
