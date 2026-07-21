import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import FormData from "form-data";
import sharp from "sharp";

// Mock fs/promises: o endpoint /v1/images/process é STATELESS e não deve
// escrever nada em disco. Se qualquer writeFile/mkdir for chamado, os asserts
// abaixo (não chamado) falham — garantindo a propriedade stateless.
const writeFileMock = vi.fn().mockResolvedValue(undefined);
const mkdirMock = vi.fn().mockResolvedValue(undefined);

vi.mock("fs/promises", () => ({
  writeFile: (...args: any[]) => writeFileMock(...args),
  mkdir: (...args: any[]) => mkdirMock(...args),
}));

// Mock do service para isolar o teste do endpoint da lógica de imagem (que já
// tem cobertura em tests/image-processing.spec.ts, inclusive o mock do sidecar
// via rembgFetcher). Aqui validamos o CONTRATO da rota: parsing, validação,
// content-type, headers X-* e resposta binária.
const processUploadedImageMock = vi.fn();
vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  processUploadedImage: (...args: any[]) => processUploadedImageMock(...args),
}));

// authMiddleware protege POST /v1/images/process. Aqui mockamos para no-op
// (passa direto) — a auth real (401/strict) é coberta em
// tests/image.routes.auth.spec.ts.
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async () => {},
}));

import { imageRoutes } from "../app/routes/image.routes";

async function makeImage(
  width = 400,
  height = 300,
  format: "jpeg" | "png" | "webp" = "jpeg",
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .toFormat(format)
    .toBuffer();
}

function buildForm({
  file,
  filename,
  mimetype,
  removeBackground,
  addShadow,
}: {
  file?: Buffer;
  filename?: string;
  mimetype?: string;
  removeBackground?: string;
  addShadow?: string;
}): { headers: Record<string, string>; body: Buffer } {
  const form = new FormData();
  if (file) {
    form.append("file", file, {
      filename: filename ?? "input.jpg",
      contentType: mimetype ?? "image/jpeg",
    });
  }
  if (removeBackground !== undefined) {
    form.append("removeBackground", removeBackground);
  }
  if (addShadow !== undefined) {
    form.append("addShadow", addShadow);
  }
  return {
    headers: form.getHeaders(),
    body: form.getBuffer(),
  };
}

describe("POST /v1/images/process", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    writeFileMock.mockClear();
    mkdirMock.mockClear();
    processUploadedImageMock.mockReset();

    app = fastify();
    // Limite igual ao de produção (api.ts): 20 MB exatos. Assim o teste de
    // oversize exercita o caminho REAL (o toBuffer estoura o limite global).
    await app.register(multipart, {
      limits: { fileSize: 20 * 1024 * 1024 },
    });
    await app.register(imageRoutes, { prefix: "/v1/images" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("rejeita requisição sem multipart", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ foo: "bar" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejeita quando falta o campo file", async () => {
    const { headers, body } = buildForm({});
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/Arquivo/i);
  });

  it("rejeita mimetype não suportado", async () => {
    const file = Buffer.from("not really an image");
    const { headers, body } = buildForm({
      file,
      filename: "doc.pdf",
      mimetype: "application/pdf",
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/Tipo/i);
  });

  it("rejeita arquivo > 20MB com 400 (não 413/500)", async () => {
    // Arquivo acima do limite global do multipart (20 MB). O toBuffer() estoura
    // com FST_REQ_FILE_TOO_LARGE; o handler detecta pelo code e devolve 400.
    const file = Buffer.alloc(20 * 1024 * 1024 + 1024, 0xff);
    const { headers, body } = buildForm({
      file,
      filename: "big.jpg",
      mimetype: "image/jpeg",
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/grande/i);
    // Nada foi processado nem persistido.
    expect(processUploadedImageMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("removeBackground=true + addShadow=true → PNG binário + headers X-*", async () => {
    const file = await makeImage(800, 600, "jpeg");
    const processed = await makeImage(1600, 1200, "png");
    processUploadedImageMock.mockResolvedValue({
      processed,
      format: "png",
      removedBackground: true,
      shadowApplied: true,
      width: 1600,
      height: 1200,
    });

    const { headers, body } = buildForm({
      file,
      filename: "p.jpg",
      mimetype: "image/jpeg",
      removeBackground: "true",
      addShadow: "true",
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-removed-background"]).toBe("true");
    expect(res.headers["x-shadow-applied"]).toBe("true");
    expect(res.headers["x-image-format"]).toBe("png");
    expect(res.headers["x-image-width"]).toBe("1600");
    expect(res.headers["x-image-height"]).toBe("1200");
    expect(res.headers["x-warning"]).toBeUndefined();
    // O corpo é exatamente os bytes processados.
    expect(Buffer.compare(res.rawPayload, processed)).toBe(0);
    // Reusa o pipeline com os flags certos.
    expect(processUploadedImageMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ removeBackground: true, addShadow: true }),
    );
    // STATELESS: nada escrito em disco.
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
  });

  it("removeBackground=false → WebP binário + X-Removed-Background:false", async () => {
    const file = await makeImage(800, 600, "jpeg");
    const processed = await makeImage(800, 600, "webp");
    processUploadedImageMock.mockResolvedValue({
      processed,
      format: "webp",
      removedBackground: false,
      width: 800,
      height: 600,
    });

    const { headers, body } = buildForm({
      file,
      filename: "p.jpg",
      mimetype: "image/jpeg",
      removeBackground: "false",
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["x-removed-background"]).toBe("false");
    expect(res.headers["x-shadow-applied"]).toBe("false");
    expect(res.headers["x-image-format"]).toBe("webp");
    expect(Buffer.compare(res.rawPayload, processed)).toBe(0);
    expect(processUploadedImageMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ removeBackground: false }),
    );
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("degradação graceful (sidecar offline) → 200 + WebP + X-Warning ASCII", async () => {
    const file = await makeImage(800, 600, "jpeg");
    const processed = await makeImage(800, 600, "webp");
    processUploadedImageMock.mockResolvedValue({
      processed,
      format: "webp",
      removedBackground: false,
      warning:
        "Remoção de fundo indisponível; usamos a imagem otimizada original.",
      width: 800,
      height: 600,
    });

    const { headers, body } = buildForm({
      file,
      filename: "p.jpg",
      mimetype: "image/jpeg",
      removeBackground: "true",
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers,
      payload: body,
    });

    // Nunca 500: falha do sidecar é degradação graceful.
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["x-removed-background"]).toBe("false");
    // Header ASCII-folded: sem acentos (latin1-safe), ainda legível.
    expect(res.headers["x-warning"]).toBe(
      "Remocao de fundo indisponivel; usamos a imagem otimizada original.",
    );
    expect(Buffer.compare(res.rawPayload, processed)).toBe(0);
  });

  it("default do removeBackground é true quando o campo é omitido", async () => {
    const file = await makeImage(800, 600, "jpeg");
    const processed = await makeImage(800, 600, "png");
    processUploadedImageMock.mockResolvedValue({
      processed,
      format: "png",
      removedBackground: true,
    });

    const { headers, body } = buildForm({
      file,
      filename: "p.jpg",
      mimetype: "image/jpeg",
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(processUploadedImageMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ removeBackground: true }),
    );
  });

  it("omite X-Image-Width/Height quando o serviço não devolve dimensões", async () => {
    const file = await makeImage(800, 600, "jpeg");
    const processed = await makeImage(800, 600, "png");
    processUploadedImageMock.mockResolvedValue({
      processed,
      format: "png",
      removedBackground: true,
      // sem width/height
    });

    const { headers, body } = buildForm({
      file,
      filename: "p.jpg",
      mimetype: "image/jpeg",
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-image-width"]).toBeUndefined();
    expect(res.headers["x-image-height"]).toBeUndefined();
  });

  it('usa a lane "public" (cota reservada, não starva o modal interno)', async () => {
    const file = await makeImage(800, 600, "jpeg");
    const processed = await makeImage(800, 600, "png");
    processUploadedImageMock.mockResolvedValue({
      processed,
      format: "png",
      removedBackground: true,
    });

    const { headers, body } = buildForm({
      file,
      filename: "p.jpg",
      mimetype: "image/jpeg",
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/process",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(processUploadedImageMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ lane: "public" }),
    );
  });
});
