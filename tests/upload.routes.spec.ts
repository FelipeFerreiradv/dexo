import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import FormData from "form-data";
import sharp from "sharp";

// Mock fs/promises para evitar criar arquivos reais nos testes.
const writeFileMock = vi.fn().mockResolvedValue(undefined);
const mkdirMock = vi.fn().mockResolvedValue(undefined);

vi.mock("fs/promises", () => ({
  writeFile: (...args: any[]) => writeFileMock(...args),
  mkdir: (...args: any[]) => mkdirMock(...args),
}));

// Mock do service para isolar o teste do endpoint da lógica de imagem
// (que já tem cobertura em tests/image-processing.spec.ts).
const processUploadedImageMock = vi.fn();
vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  processUploadedImage: (...args: any[]) => processUploadedImageMock(...args),
}));

// authMiddleware agora protege POST /upload/image. Aqui mockamos para um
// no-op (passa direto) — o foco destes testes é o pipeline de imagem, não a
// auth (coberta em tests/security/api-auth-token.spec.ts).
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async () => {},
}));

import { uploadRoutes } from "../app/routes/upload.routes";

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

describe("POST /upload/image", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.APP_BACKEND_URL = "http://test.local";
    writeFileMock.mockClear();
    mkdirMock.mockClear();
    processUploadedImageMock.mockReset();

    app = fastify();
    await app.register(multipart, {
      limits: { fileSize: 20 * 1024 * 1024 + 1024 },
    });
    await app.register(uploadRoutes, { prefix: "/upload" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("rejeita requisição sem multipart", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/upload/image",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ foo: "bar" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejeita quando falta o campo file", async () => {
    const { headers, body } = buildForm({});
    const res = await app.inject({
      method: "POST",
      url: "/upload/image",
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
      url: "/upload/image",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/Tipo/i);
  });

  it("rejeita arquivo > 20MB", async () => {
    // Cria um buffer maior que 20MB no campo file.
    const file = Buffer.alloc(20 * 1024 * 1024 + 10, 0xff);
    const { headers, body } = buildForm({
      file,
      filename: "big.jpg",
      mimetype: "image/jpeg",
    });
    const res = await app.inject({
      method: "POST",
      url: "/upload/image",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/grande/i);
  });

  it("upload válido com removeBackground=false salva original + WebP processada", async () => {
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
      url: "/upload/image",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.success).toBe(true);
    expect(payload.removedBackground).toBe(false);
    expect(payload.format).toBe("webp");
    expect(payload.imageUrl).toMatch(
      /^http:\/\/test\.local\/uploads\/.+\.webp$/,
    );
    expect(payload.originalUrl).toMatch(
      /^http:\/\/test\.local\/uploads\/.+\.orig\.jpg$/,
    );
    expect(payload.warning).toBeUndefined();
    // writeFile foi chamado 2x: original + processada.
    expect(writeFileMock).toHaveBeenCalledTimes(2);
    // processUploadedImage foi chamado com removeBackground=false.
    expect(processUploadedImageMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ removeBackground: false }),
    );
  });

  it("upload com removeBackground=true devolve PNG transparente", async () => {
    const file = await makeImage(800, 600, "jpeg");
    const processed = await makeImage(800, 600, "png");
    processUploadedImageMock.mockResolvedValue({
      processed,
      format: "png",
      removedBackground: true,
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
      url: "/upload/image",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.removedBackground).toBe(true);
    expect(payload.format).toBe("png");
    expect(payload.imageUrl).toMatch(/\.png$/);
    expect(processUploadedImageMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ removeBackground: true }),
    );
  });

  it("propaga warning quando o pipeline degradou (sidecar offline)", async () => {
    const file = await makeImage(800, 600, "jpeg");
    const processed = await makeImage(800, 600, "webp");
    processUploadedImageMock.mockResolvedValue({
      processed,
      format: "webp",
      removedBackground: false,
      warning:
        "Remoção de fundo indisponível; usamos a imagem otimizada original.",
    });

    const { headers, body } = buildForm({
      file,
      filename: "p.jpg",
      mimetype: "image/jpeg",
      removeBackground: "true",
    });
    const res = await app.inject({
      method: "POST",
      url: "/upload/image",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.removedBackground).toBe(false);
    expect(payload.warning).toMatch(/indisponível/i);
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
      url: "/upload/image",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(processUploadedImageMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ removeBackground: true }),
    );
  });

  it("preserva o original em arquivo .orig.<ext>", async () => {
    const file = await makeImage(800, 600, "png");
    processUploadedImageMock.mockResolvedValue({
      processed: file,
      format: "webp",
      removedBackground: false,
    });

    const { headers, body } = buildForm({
      file,
      filename: "p.png",
      mimetype: "image/png",
      removeBackground: "false",
    });
    await app.inject({
      method: "POST",
      url: "/upload/image",
      headers,
      payload: body,
    });

    // O primeiro writeFile é o original (`.orig.png`).
    const originalCall = writeFileMock.mock.calls[0];
    expect(originalCall[0]).toMatch(/\.orig\.png$/);
    // O segundo é a processada (`.webp`).
    const processedCall = writeFileMock.mock.calls[1];
    expect(processedCall[0]).toMatch(/\.webp$/);
  });

  it("repassa addShadow=true e devolve shadowApplied na resposta", async () => {
    const file = await makeImage(800, 600, "jpeg");
    const processed = await makeImage(800, 600, "png");
    processUploadedImageMock.mockResolvedValue({
      processed,
      format: "png",
      removedBackground: true,
      shadowApplied: true,
      width: 800,
      height: 600,
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
      url: "/upload/image",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.shadowApplied).toBe(true);
    expect(processUploadedImageMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ removeBackground: true, addShadow: true }),
    );
  });

  it("default do addShadow é false quando o campo é omitido", async () => {
    const file = await makeImage(800, 600, "jpeg");
    const processed = await makeImage(800, 600, "png");
    processUploadedImageMock.mockResolvedValue({
      processed,
      format: "png",
      removedBackground: true,
      shadowApplied: false,
    });

    const { headers, body } = buildForm({
      file,
      filename: "p.jpg",
      mimetype: "image/jpeg",
    });
    const res = await app.inject({
      method: "POST",
      url: "/upload/image",
      headers,
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    expect(payload.shadowApplied).toBe(false);
    expect(processUploadedImageMock).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ addShadow: false }),
    );
  });
});
