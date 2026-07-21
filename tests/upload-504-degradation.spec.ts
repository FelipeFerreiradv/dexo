/**
 * Regressão do incidente do 504-sem-CORS no modal de criação de produto.
 *
 * Este spec sobe a rota REAL (sem mockar `image-resize.service`) contra um
 * sidecar que NUNCA responde, e prova a propriedade que faltava em produção:
 *
 *   com o sidecar travado, `POST /upload/image` responde **200 + warning**,
 *   **com header CORS**, **dentro do orçamento** — em vez de pendurar até o
 *   nginx cortar com um 504 que o browser sequer consegue ler.
 *
 * Antes da correção, `REMBG_TIMEOUT_MS` (60000, igual ao `proxy_read_timeout`
 * default do nginx) tornava a degradação graceful inalcançável.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import FormData from "form-data";
import sharp from "sharp";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async () => {},
}));

import { uploadRoutes } from "../app/routes/upload.routes";
import { __resetRembgGate } from "../app/marketplaces/services/rembg-gate";

const ORIGIN = "https://app.usedexo.com.br";

/** Sidecar que aceita a conexão e nunca responde — o pior caso real (fila). */
let blackhole: Server;
let sidecarUrl = "";

beforeAll(async () => {
  blackhole = createServer(() => {
    /* engole a request de propósito: nunca responde */
  });
  await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  const { port } = blackhole.address() as AddressInfo;
  sidecarUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  blackhole.closeAllConnections?.();
  await new Promise<void>((resolve) => blackhole.close(() => resolve()));
});

afterEach(() => {
  delete process.env.REMBG_SIDECAR_URL;
  delete process.env.REMBG_ENABLED;
  delete process.env.REMBG_TIMEOUT_MS;
  delete process.env.UPLOAD_HANDLER_BUDGET_MS;
  __resetRembgGate();
  vi.restoreAllMocks();
});

async function buildApp(): Promise<FastifyInstance> {
  const app = fastify();
  // Mesma configuração de CORS do app real (`app/api/api.ts`): origin string.
  await app.register(cors, { origin: ORIGIN, credentials: true });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(uploadRoutes, { prefix: "/upload" });
  await app.ready();
  return app;
}

async function makeForm() {
  const file = await sharp({
    create: {
      width: 900,
      height: 700,
      channels: 3,
      background: { r: 120, g: 90, b: 60 },
    },
  })
    .jpeg()
    .toBuffer();

  const form = new FormData();
  form.append("file", file, {
    filename: "peca.jpg",
    contentType: "image/jpeg",
  });
  form.append("removeBackground", "true");
  form.append("addShadow", "true");
  return { headers: form.getHeaders(), body: form.getBuffer() };
}

describe("POST /upload/image com o sidecar travado", () => {
  it("degrada para 200 + warning COM CORS, dentro do orçamento", async () => {
    process.env.REMBG_SIDECAR_URL = sidecarUrl;
    process.env.REMBG_ENABLED = "true";
    // Simula o .env de produção: 60s, o valor que tornava a degradação
    // inalcançável. O clamp pelo orçamento é justamente o que corrige isso.
    process.env.REMBG_TIMEOUT_MS = "60000";
    // Acima de RESERVE(3s) + MIN_USEFUL(7s), para o sidecar ser REALMENTE
    // chamado e o axios abortar pelo orçamento — que é o caminho sob teste.
    process.env.UPLOAD_HANDLER_BUDGET_MS = "13000";
    __resetRembgGate();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = await buildApp();
    const { headers, body } = await makeForm();

    const startedAt = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/upload/image",
      headers: { ...headers, origin: ORIGIN },
      payload: body,
    });
    const elapsed = Date.now() - startedAt;

    // 1) Respondeu — e respondeu 200, não erro.
    expect(res.statusCode).toBe(200);

    // 2) Com CORS. É o que o browser precisa para conseguir LER a resposta.
    //    (O 504 do nginx não passa pelo @fastify/cors — daí o sintoma.)
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);

    // 3) Degradou de forma graceful, avisando o usuário.
    const payload = JSON.parse(res.payload);
    expect(payload.removedBackground).toBe(false);
    expect(payload.format).toBe("webp");
    expect(payload.warning).toBeTruthy();
    expect(payload.imageUrl).toMatch(/\.webp$/);

    // 4) DENTRO do orçamento — antes de qualquer proxy_read_timeout plausível.
    //    Sem o clamp, ficaria pendurado nos 60s do REMBG_TIMEOUT_MS.
    expect(elapsed).toBeLessThan(13_000);

    await app.close();
  }, 30_000);

  it("com o orçamento já vencido responde 200 sem sequer abrir a conexão", async () => {
    process.env.REMBG_SIDECAR_URL = sidecarUrl;
    process.env.REMBG_ENABLED = "true";
    process.env.REMBG_TIMEOUT_MS = "60000";
    // Orçamento menor que a reserva do fallback => nem tenta o sidecar.
    process.env.UPLOAD_HANDLER_BUDGET_MS = "1";
    __resetRembgGate();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const app = await buildApp();
    const { headers, body } = await makeForm();

    const startedAt = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/upload/image",
      headers: { ...headers, origin: ORIGIN },
      payload: body,
    });
    const elapsed = Date.now() - startedAt;

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(JSON.parse(res.payload).warning).toBeTruthy();
    // Nada de round-trip: resposta praticamente imediata.
    expect(elapsed).toBeLessThan(3_000);

    await app.close();
  }, 20_000);
});
