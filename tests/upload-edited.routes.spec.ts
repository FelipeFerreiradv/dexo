import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import FormData from "form-data";

// Mesmo molde do upload-async.routes.spec.ts.
const writeFileMock = vi.fn().mockResolvedValue(undefined);
const mkdirMock = vi.fn().mockResolvedValue(undefined);
const unlinkMock = vi.fn().mockResolvedValue(undefined);
const accessMock = vi.fn();
vi.mock("fs/promises", () => ({
  writeFile: (...args: any[]) => writeFileMock(...args),
  mkdir: (...args: any[]) => mkdirMock(...args),
  unlink: (...args: any[]) => unlinkMock(...args),
  access: (...args: any[]) => accessMock(...args),
  readFile: vi.fn(),
}));

vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  processUploadedImage: vi.fn(),
}));

// COLABORADOR: dataOwnerId difere do user.id — a receita pertence ao tenant.
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "u1", role: "USER", dataOwnerId: "owner1" };
  },
}));

vi.mock("../app/marketplaces/services/rembg-telemetry", () => ({
  recordImageOutcome: vi.fn(),
}));

const editCreateMock = vi.fn();
const editFindFirstMock = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: {
    imageBgJob: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    productImageEdit: {
      create: (...a: any[]) => editCreateMock(...a),
      findFirst: (...a: any[]) => editFindFirstMock(...a),
    },
  },
}));

import { uploadRoutes } from "../app/routes/upload.routes";

const RECIPE = {
  version: 1,
  presetId: "ml-1200",
  canvas: { width: 1200, height: 1200 },
  source: { fileName: "abc.png", width: 1490, height: 1600 },
  background: { mode: "white" },
  paddingPct: 88,
  base: { left: 600, top: 600, scaleX: 0.66, scaleY: 0.66, angle: 0 },
  layers: [],
};

function buildForm(
  fields: Record<string, string>,
  file?: { buf: Buffer; contentType: string },
) {
  const form = new FormData();
  if (file) {
    form.append("file", file.buf, {
      filename: "edited.png",
      contentType: file.contentType,
    });
  }
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return { headers: form.getHeaders(), body: form.getBuffer() };
}

describe("POST /upload/image/edited (Editor, PR 6)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.APP_BACKEND_URL = "http://test.local";
    vi.clearAllMocks();
    app = fastify();
    await app.register(multipart, { limits: { fileSize: 21 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/upload" });
  });

  afterEach(async () => {
    await app.close();
  });

  it("salva PNG + receita atomicamente, escopado pelo TENANT (dataOwnerId)", async () => {
    editCreateMock.mockResolvedValue({ id: "edit-1" });
    const { headers, body } = buildForm(
      {
        recipe: JSON.stringify(RECIPE),
        sourceFileName: "abc.png",
        cutoutFileName: "abc.png",
      },
      { buf: Buffer.from("png-bytes"), contentType: "image/png" },
    );
    const res = await app.inject({
      method: "POST",
      url: "/upload/image/edited",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.imageUrl).toMatch(/^http:\/\/test\.local\/uploads\/.+\.png$/);
    expect(json.fileName).toMatch(/\.png$/);
    // O arquivo NOVO nunca reusa o nome da fonte (versionamento por uuid).
    expect(json.fileName).not.toBe("abc.png");
    expect(writeFileMock).toHaveBeenCalledTimes(1);

    const created = editCreateMock.mock.calls[0][0].data;
    expect(created.userId).toBe("owner1"); // dataOwnerId, não user.id
    expect(created.sourceFileName).toBe("abc.png");
    expect(created.cutoutFileName).toBe("abc.png");
    expect(created.recipe.version).toBe(1);
    expect(created.fileName).toBe(json.fileName);
  });

  it("create da receita falhou: apaga o arquivo salvo e responde 500", async () => {
    editCreateMock.mockRejectedValue(new Error("tabela ausente"));
    const { headers, body } = buildForm(
      { recipe: JSON.stringify(RECIPE), sourceFileName: "abc.png" },
      { buf: Buffer.from("png"), contentType: "image/png" },
    );
    const res = await app.inject({
      method: "POST",
      url: "/upload/image/edited",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(500);
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it("recipe inválida (não-JSON ou version≠1) => 400 sem gravar nada", async () => {
    for (const recipe of ["nao-json", JSON.stringify({ version: 2 })]) {
      const { headers, body } = buildForm(
        { recipe, sourceFileName: "abc.png" },
        { buf: Buffer.from("png"), contentType: "image/png" },
      );
      const res = await app.inject({
        method: "POST",
        url: "/upload/image/edited",
        headers,
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(editCreateMock).not.toHaveBeenCalled();
  });

  it("path traversal em sourceFileName => 400", async () => {
    const { headers, body } = buildForm(
      {
        recipe: JSON.stringify(RECIPE),
        sourceFileName: "../../etc/passwd",
      },
      { buf: Buffer.from("png"), contentType: "image/png" },
    );
    const res = await app.inject({
      method: "POST",
      url: "/upload/image/edited",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("mimetype fora de PNG/JPEG => 400", async () => {
    const { headers, body } = buildForm(
      { recipe: JSON.stringify(RECIPE), sourceFileName: "abc.png" },
      { buf: Buffer.from("gif"), contentType: "image/gif" },
    );
    const res = await app.inject({
      method: "POST",
      url: "/upload/image/edited",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /upload/image/meta (reabrir no editor)", () => {
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

  it("arquivo de um save anterior: devolve a receita ESCOPADA pelo tenant + original", async () => {
    editFindFirstMock.mockResolvedValue({
      recipe: RECIPE,
      sourceFileName: "abc.png",
      cutoutFileName: "abc.png",
    });
    // Original existe como .jpg (primeira extensão sondada que responde).
    accessMock.mockImplementation(async (p: string) => {
      if (String(p).endsWith("def.orig.jpg")) return undefined;
      throw new Error("ENOENT");
    });

    const res = await app.inject({
      method: "GET",
      url: "/upload/image/meta?fileName=def.png",
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(editFindFirstMock.mock.calls[0][0].where).toMatchObject({
      fileName: "def.png",
      userId: "owner1",
    });
    expect(json.edit.sourceUrl).toBe("http://test.local/uploads/abc.png");
    expect(json.edit.cutoutUrl).toBe("http://test.local/uploads/abc.png");
    expect(json.originalUrl).toBe("http://test.local/uploads/def.orig.jpg");
  });

  it("sem receita e sem original: 200 magro (só o fileName)", async () => {
    editFindFirstMock.mockResolvedValue(null);
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const res = await app.inject({
      method: "GET",
      url: "/upload/image/meta?fileName=ghi.webp",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fileName: "ghi.webp" });
  });

  it("fileName com traversal => 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/upload/image/meta?fileName=${encodeURIComponent("../../x")}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("tabela da receita ausente (DDL pendente): rota não derruba", async () => {
    editFindFirstMock.mockRejectedValue(new Error("does not exist"));
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const res = await app.inject({
      method: "GET",
      url: "/upload/image/meta?fileName=abc.png",
    });
    expect(res.statusCode).toBe(200);
  });
});
