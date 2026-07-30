import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";

vi.mock("fs/promises", () => ({
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  processUploadedImage: vi.fn(),
}));
vi.mock("../app/marketplaces/services/rembg-telemetry", () => ({
  recordImageOutcome: vi.fn(),
}));
// COLABORADOR: a biblioteca pertence ao tenant (dataOwnerId), não ao user.id.
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "u1", role: "USER", dataOwnerId: "owner1" };
  },
}));

const assetCreateMock = vi.fn();
const assetFindManyMock = vi.fn();
const assetDeleteManyMock = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: {
    imageBgJob: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    productImageEdit: { create: vi.fn(), findFirst: vi.fn() },
    editorAsset: {
      create: (...a: any[]) => assetCreateMock(...a),
      findMany: (...a: any[]) => assetFindManyMock(...a),
      deleteMany: (...a: any[]) => assetDeleteManyMock(...a),
    },
  },
}));

import { uploadRoutes } from "../app/routes/upload.routes";

describe("Biblioteca de veículos do editor (/upload/image/assets)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.APP_BACKEND_URL = "http://test.local";
    vi.clearAllMocks();
    app = fastify();
    await app.register(multipart, { limits: { fileSize: 1024 } });
    await app.register(uploadRoutes, { prefix: "/upload" });
  });

  afterEach(async () => {
    await app.close();
  });

  it("registra um asset escopado pelo TENANT, com URL montada", async () => {
    assetCreateMock.mockResolvedValue({
      id: "as1",
      fileName: "abc.png",
      label: "Lifan 530",
    });
    const res = await app.inject({
      method: "POST",
      url: "/upload/image/assets",
      payload: { fileName: "abc.png", label: "Lifan 530" },
    });
    expect(res.statusCode).toBe(200);
    expect(assetCreateMock.mock.calls[0][0].data).toMatchObject({
      userId: "owner1", // dataOwnerId, não user.id
      fileName: "abc.png",
      kind: "vehicle",
    });
    expect(res.json().asset.url).toBe("http://test.local/uploads/abc.png");
  });

  it("fileName com traversal => 400 sem tocar o banco", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/upload/image/assets",
      payload: { fileName: "../../etc/passwd" },
    });
    expect(res.statusCode).toBe(400);
    expect(assetCreateMock).not.toHaveBeenCalled();
  });

  it("lista SÓ os assets do tenant, mais novos primeiro, com teto de 100", async () => {
    assetFindManyMock.mockResolvedValue([
      { id: "a2", fileName: "b.png", label: null },
      { id: "a1", fileName: "a.png", label: "Gol G5" },
    ]);
    const res = await app.inject({ method: "GET", url: "/upload/image/assets" });
    expect(res.statusCode).toBe(200);
    expect(assetFindManyMock.mock.calls[0][0]).toMatchObject({
      where: { userId: "owner1", kind: "vehicle" },
      take: 100,
    });
    expect(res.json().assets).toHaveLength(2);
    expect(res.json().assets[1].url).toBe("http://test.local/uploads/a.png");
  });

  it("tabela ausente (DDL pendente): lista vazia, nunca 500", async () => {
    assetFindManyMock.mockRejectedValue(new Error("does not exist"));
    const res = await app.inject({ method: "GET", url: "/upload/image/assets" });
    expect(res.statusCode).toBe(200);
    expect(res.json().assets).toEqual([]);
  });

  it("delete: só do próprio tenant; alheio/ausente => 404 (linha só — o arquivo fica p/ receitas antigas)", async () => {
    assetDeleteManyMock.mockResolvedValueOnce({ count: 1 });
    const ok = await app.inject({
      method: "DELETE",
      url: "/upload/image/assets/as1",
    });
    expect(ok.statusCode).toBe(200);
    expect(assetDeleteManyMock.mock.calls[0][0].where).toEqual({
      id: "as1",
      userId: "owner1",
    });

    assetDeleteManyMock.mockResolvedValueOnce({ count: 0 });
    const notFound = await app.inject({
      method: "DELETE",
      url: "/upload/image/assets/de-outro",
    });
    expect(notFound.statusCode).toBe(404);
  });
});
