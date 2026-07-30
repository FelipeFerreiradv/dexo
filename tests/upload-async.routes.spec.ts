import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import FormData from "form-data";
import sharp from "sharp";

// Mocks no molde de tests/upload.routes.spec.ts.
const writeFileMock = vi.fn().mockResolvedValue(undefined);
const mkdirMock = vi.fn().mockResolvedValue(undefined);
vi.mock("fs/promises", () => ({
  writeFile: (...args: any[]) => writeFileMock(...args),
  mkdir: (...args: any[]) => mkdirMock(...args),
  readFile: vi.fn(),
}));

const processUploadedImageMock = vi.fn();
vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  processUploadedImage: (...args: any[]) => processUploadedImageMock(...args),
}));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "u1", role: "ADMIN" };
  },
}));

const recordImageOutcomeMock = vi.fn();
vi.mock("../app/marketplaces/services/rembg-telemetry", () => ({
  recordImageOutcome: (...args: any[]) => recordImageOutcomeMock(...args),
}));

const jobCreateMock = vi.fn();
const jobFindManyMock = vi.fn();
const jobUpdateManyMock = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: {
    imageBgJob: {
      create: (...a: any[]) => jobCreateMock(...a),
      findMany: (...a: any[]) => jobFindManyMock(...a),
      updateMany: (...a: any[]) => jobUpdateManyMock(...a),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { uploadRoutes } from "../app/routes/upload.routes";

async function makeImage(): Promise<Buffer> {
  return sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg()
    .toBuffer();
}

function buildForm(fields: Record<string, string>, file?: Buffer) {
  const form = new FormData();
  if (file) {
    form.append("file", file, { filename: "p.jpg", contentType: "image/jpeg" });
  }
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return { headers: form.getHeaders(), body: form.getBuffer() };
}

const WEBP_RESULT = {
  processed: Buffer.from("webp-bytes"),
  format: "webp" as const,
  removedBackground: false,
  width: 400,
  height: 300,
};

describe("POST /upload/image — caminho ASSÍNCRONO (duplo opt-in)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.APP_BACKEND_URL = "http://test.local";
    delete process.env.UPLOAD_ASYNC_REMBG;
    vi.clearAllMocks();
    app = fastify();
    await app.register(multipart, { limits: { fileSize: 21 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/upload" });
  });

  afterEach(async () => {
    delete process.env.UPLOAD_ASYNC_REMBG;
    await app.close();
  });

  it("env OFF: asyncBg do cliente é IGNORADO — caminho síncrono byte-a-byte", async () => {
    processUploadedImageMock.mockResolvedValue({
      ...WEBP_RESULT,
      removedBackground: true,
      format: "png",
      processed: Buffer.from("png"),
    });
    const { headers, body } = buildForm(
      { removeBackground: "true", asyncBg: "true" },
      await makeImage(),
    );
    const res = await app.inject({ method: "POST", url: "/upload/image", headers, payload: body });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.bgJob).toBeUndefined();
    expect(jobCreateMock).not.toHaveBeenCalled();
    // Caminho síncrono normal: processa COM remoção.
    expect(processUploadedImageMock.mock.calls[0][1].removeBackground).toBe(true);
  });

  it("env ON + asyncBg: responde JÁ com a WebP + bgJob, SEM warning e SEM telemetria de upload", async () => {
    process.env.UPLOAD_ASYNC_REMBG = "1";
    processUploadedImageMock.mockResolvedValue(WEBP_RESULT);
    jobCreateMock.mockResolvedValue({ id: "job-1" });

    const { headers, body } = buildForm(
      { removeBackground: "true", addShadow: "true", asyncBg: "true" },
      await makeImage(),
    );
    const res = await app.inject({ method: "POST", url: "/upload/image", headers, payload: body });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.bgJob).toEqual({ jobId: "job-1", status: "PENDING" });
    expect(json.removedBackground).toBe(false);
    expect(json.warning).toBeUndefined(); // não é degradação — é o caminho novo
    expect(json.imageUrl).toContain(".webp");

    // A WebP é gerada SEM tocar o sidecar (o recorte fica para o worker).
    expect(processUploadedImageMock).toHaveBeenCalledTimes(1);
    expect(processUploadedImageMock.mock.calls[0][1]).toEqual({
      removeBackground: false,
    });
    // Job criado com o que o worker precisa (incl. dono e sombra pedida).
    const created = jobCreateMock.mock.calls[0][0].data;
    expect(created.addShadow).toBe(true);
    expect(created.userId).toBe("u1");
    expect(created.origFileName).toContain(".orig.jpg");
    // O desfecho REAL é do worker — upload não registra na taxa de fallback.
    expect(recordImageOutcomeMock).not.toHaveBeenCalled();
  });

  it("env ON sem asyncBg (cliente antigo): caminho síncrono inalterado", async () => {
    process.env.UPLOAD_ASYNC_REMBG = "1";
    processUploadedImageMock.mockResolvedValue({
      ...WEBP_RESULT,
      removedBackground: true,
      format: "png",
    });
    const { headers, body } = buildForm(
      { removeBackground: "true" },
      await makeImage(),
    );
    const res = await app.inject({ method: "POST", url: "/upload/image", headers, payload: body });

    expect(res.statusCode).toBe(200);
    expect(res.json().bgJob).toBeUndefined();
    expect(jobCreateMock).not.toHaveBeenCalled();
  });

  it("env ON + asyncBg mas removeBackground=false: síncrono (não há o que recortar)", async () => {
    process.env.UPLOAD_ASYNC_REMBG = "1";
    processUploadedImageMock.mockResolvedValue(WEBP_RESULT);
    const { headers, body } = buildForm(
      { removeBackground: "false", asyncBg: "true" },
      await makeImage(),
    );
    const res = await app.inject({ method: "POST", url: "/upload/image", headers, payload: body });

    expect(res.statusCode).toBe(200);
    expect(res.json().bgJob).toBeUndefined();
    expect(jobCreateMock).not.toHaveBeenCalled();
  });
});

describe("GET /upload/image/jobs + retry", () => {
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

  it("polling: escopado pelo dono, com URLs montadas e erro só em FAILED", async () => {
    jobFindManyMock.mockResolvedValue([
      {
        id: "j1",
        status: "PROCESSING",
        attempts: 1,
        resultFileName: null,
        webpFileName: "a.webp",
        lastError: null,
      },
      {
        id: "j2",
        status: "COMPLETED",
        attempts: 1,
        resultFileName: "b.png",
        webpFileName: "b.webp",
        lastError: null,
      },
      {
        id: "j3",
        status: "FAILED",
        attempts: 5,
        resultFileName: null,
        webpFileName: "c.webp",
        lastError: "degradou (timeout)",
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/upload/image/jobs?ids=j1,j2,j3",
    });

    expect(res.statusCode).toBe(200);
    // Ownership: o WHERE inclui o userId do requisitante.
    expect(jobFindManyMock.mock.calls[0][0].where).toMatchObject({
      userId: "u1",
      id: { in: ["j1", "j2", "j3"] },
    });
    const { jobs } = res.json();
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({ id: "j1", status: "PROCESSING" });
    expect(jobs[0].resultUrl).toBeUndefined();
    expect(jobs[1].resultUrl).toBe("http://test.local/uploads/b.png");
    expect(jobs[1].webpUrl).toBe("http://test.local/uploads/b.webp");
    expect(jobs[2].error).toContain("timeout");
  });

  it("polling sem ids: 200 com lista vazia (sem query no banco)", async () => {
    const res = await app.inject({ method: "GET", url: "/upload/image/jobs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobs).toEqual([]);
    expect(jobFindManyMock).not.toHaveBeenCalled();
  });

  it("retry: só FAILED do próprio dono; job alheio/ausente => 404", async () => {
    jobUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    const ok = await app.inject({
      method: "POST",
      url: "/upload/image/jobs/j3/retry",
    });
    expect(ok.statusCode).toBe(200);
    expect(jobUpdateManyMock.mock.calls[0][0].where).toMatchObject({
      id: "j3",
      userId: "u1",
      status: "FAILED",
    });
    expect(jobUpdateManyMock.mock.calls[0][0].data.status).toBe("PENDING");
    expect(jobUpdateManyMock.mock.calls[0][0].data.attempts).toBe(0);

    jobUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    const notFound = await app.inject({
      method: "POST",
      url: "/upload/image/jobs/de-outro/retry",
    });
    expect(notFound.statusCode).toBe(404);
  });
});
