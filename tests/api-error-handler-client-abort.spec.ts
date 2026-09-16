import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import fastifyCompress from "@fastify/compress";
import http from "http";

/**
 * 8.379 SYSTEM_ERROR "Premature close" por mês eram o PRÓPRIO formulário de
 * produto cancelando a sugestão de categoria (AbortSignal) enquanto o usuário
 * digita. O handler passa a reconhecer o aborto do cliente e não grava
 * SYSTEM_ERROR para ele — e continua gravando para erro real (controle).
 *
 * Servidor de verdade (socket real), com @fastify/compress global como em
 * produção: é o caminho que gera ERR_STREAM_PREMATURE_CLOSE.
 */

const logErrorMock = vi.hoisted(() => vi.fn());
vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logError: logErrorMock },
}));

import { createApiErrorHandler, isClientAbort } from "../app/api/error-handler";

let app: FastifyInstance;
let port: number;
const log = { info: vi.fn(), error: vi.fn() } as any;

beforeEach(async () => {
  logErrorMock.mockReset().mockResolvedValue(undefined);
  log.info.mockReset();
  log.error.mockReset();
  app = fastify();
  await app.register(fastifyCompress, { global: true });
  app.setErrorHandler(createApiErrorHandler(log));
  app.post("/lento", async () => {
    await new Promise((r) => setTimeout(r, 250));
    return { data: "x".repeat(200_000) };
  });
  app.post("/quebra", async () => {
    throw new Error("defeito real");
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as any).port;
});

afterEach(async () => {
  await app.close();
});

function abortarDepois(ms: number) {
  return new Promise<void>((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/lento",
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
    });
    req.on("error", () => {});
    req.end(JSON.stringify({ title: "farol" }));
    setTimeout(() => {
      req.destroy();
      resolve();
    }, ms);
  });
}

async function esperar(cond: () => boolean, ms = 3000) {
  const fim = Date.now() + ms;
  while (!cond() && Date.now() < fim) await new Promise((r) => setTimeout(r, 20));
}

describe("handler global de erro — aborto do cliente", () => {
  it("cliente que desiste no meio NÃO vira SYSTEM_ERROR (só log informativo)", async () => {
    await abortarDepois(60);
    await esperar(() => log.info.mock.calls.length > 0 || log.error.mock.calls.length > 0);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/lento", code: "ERR_STREAM_PREMATURE_CLOSE" }),
      "request aborted by client",
    );
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("controle: erro real da rota continua gravando SYSTEM_ERROR e respondendo 500", async () => {
    const res = await app.inject({ method: "POST", url: "/quebra", payload: {} });
    expect(res.statusCode).toBe(500);
    expect(logErrorMock).toHaveBeenCalledWith(
      "SYSTEM_ERROR",
      "POST /quebra: defeito real",
      expect.objectContaining({ resource: "Request" }),
    );
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("isClientAbort", () => {
  const req = (destroyed: boolean) => ({ raw: { socket: { destroyed } } }) as any;
  const rep = (destroyed: boolean) => ({ raw: { destroyed } }) as any;
  const premature = Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" });

  it("exige o código E a conexão fechada", () => {
    expect(isClientAbort(premature, req(true), rep(false))).toBe(true);
    expect(isClientAbort(premature, req(false), rep(true))).toBe(true);
    expect(isClientAbort(premature, req(false), rep(false))).toBe(false);
    expect(isClientAbort(new Error("Premature close"), req(true), rep(true))).toBe(false);
    expect(isClientAbort(null, req(true), rep(true))).toBe(false);
  });
});
