import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";

// Contrato G1 × G2 (prontidão V2) nas ROTAS — formato exato que a tela consome.
//
// C1. POST /fiscal/inutilizacao: `confirmarDescarteNumeros` (só o booleano true) chega ao caso
//     de uso; o 409 NUMERACAO_CONFIRMAR_DESCARTE sai como {error, code, detalhes:{numeros, serie}}
//     — o mesmo formato do DELETE /nfe/draft/:id.
// C2. POST /fiscal/nfe/:id/numeracao/descartar-bloqueado, corpo {confirmar?}: 200
//     {ok, numeroDescartado, serie}; 409 NUMERACAO_CONFIRMAR_DESCARTE {numero, serie};
//     409 NUMERACAO_NAO_BLOQUEADA; 404 nota inexistente/de outro tenant.

const TENANT = "tenant-dls";
const h = vi.hoisted(() => ({ usuario: {} as Record<string, unknown> }));
const db = vi.hoisted(() => ({ nfeEmitida: { findFirst: async () => null } }));

vi.mock("../../../app/lib/prisma", () => ({ default: db }));
vi.mock("@/app/lib/prisma", () => ({ default: db }));
vi.mock("../../../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { ...h.usuario, dataOwnerId: TENANT };
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { fiscalRoutes } from "../../../app/routes/fiscal.routes";
import { NumeracaoError } from "../../../app/fiscal/numeracao/numeracao.errors";
import { NfeDraftUseCase } from "../../../app/usecases/nfe-draft.usecase";
import { NfeInutilizacaoUseCase } from "../../../app/usecases/nfe-inutilizacao.usecase";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(fiscalRoutes, { prefix: "/fiscal" });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

// Espiões reinstalados a cada teste (afterEach restaura).
let inutilizar: MockInstance;
let descartar: MockInstance;
afterEach(() => {
  vi.restoreAllMocks();
});

function espiar() {
  h.usuario = { id: "colab-1", parentUserId: TENANT, pagePermissions: null };
  inutilizar = vi.spyOn(NfeInutilizacaoUseCase.prototype, "inutilizar").mockResolvedValue({
    success: true, id: "inut-1", status: "ACEITA", protocolo: "135", mensagem: "Inutilizacao aceita",
  } as never);
  descartar = vi.spyOn(NfeDraftUseCase.prototype, "descartarNumeroBloqueado").mockResolvedValue({ numero: 501, serie: 1 });
}

const CORPO_INUT = { serie: 1, numeroInicial: 7, numeroFinal: 9, justificativa: "Numero nao utilizado por erro de sistema" };

describe("C1 — POST /fiscal/inutilizacao", () => {
  it("confirmarDescarteNumeros:true chega ao caso de uso (com o autor da ação)", async () => {
    espiar();
    const res = await app.inject({ method: "POST", url: "/fiscal/inutilizacao", payload: { ...CORPO_INUT, confirmarDescarteNumeros: true } });
    expect(res.statusCode).toBe(200);
    expect(inutilizar).toHaveBeenCalledTimes(1);
    expect(inutilizar.mock.calls[0][0]).toBe(TENANT);
    expect(inutilizar.mock.calls[0][1]).toMatchObject({ serie: 1, numeroInicial: 7, numeroFinal: 9, confirmarDescarteNumeros: true, actorUserId: "colab-1" });
  });

  it.each([
    ["ausente", {}],
    ["string 'true'", { confirmarDescarteNumeros: "true" }],
    ["1", { confirmarDescarteNumeros: 1 }],
  ])("confirmarDescarteNumeros %s ⇒ false (só o booleano true confirma)", async (_nome, extra) => {
    espiar();
    await app.inject({ method: "POST", url: "/fiscal/inutilizacao", payload: { ...CORPO_INUT, ...extra } });
    expect(inutilizar.mock.calls[0][1]).toMatchObject({ confirmarDescarteNumeros: false });
  });

  it("409 NUMERACAO_CONFIRMAR_DESCARTE sai como {error, code, detalhes:{numeros, serie}}", async () => {
    espiar();
    inutilizar.mockRejectedValueOnce(new NumeracaoError("NUMERACAO_CONFIRMAR_DESCARTE", 409, "O nº 7 (série 1) está reservado…", { numeros: [7], serie: 1 }));
    const res = await app.inject({ method: "POST", url: "/fiscal/inutilizacao", payload: CORPO_INUT });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "O nº 7 (série 1) está reservado…", code: "NUMERACAO_CONFIRMAR_DESCARTE", detalhes: { numeros: [7], serie: 1 } });
  });

  it("FAIXA_COM_NUMERO_VIVO continua 400 com {error, code}", async () => {
    espiar();
    inutilizar.mockRejectedValueOnce(new NumeracaoError("FAIXA_COM_NUMERO_VIVO", 400, "nº 8 tem reserva de numeração em INCERTO"));
    const res = await app.inject({ method: "POST", url: "/fiscal/inutilizacao", payload: CORPO_INUT });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "nº 8 tem reserva de numeração em INCERTO", code: "FAIXA_COM_NUMERO_VIVO" });
  });
});

describe("C2 — POST /fiscal/nfe/:id/numeracao/descartar-bloqueado", () => {
  const URL = "/fiscal/nfe/nfe-1/numeracao/descartar-bloqueado";

  it("confirmar:true ⇒ 200 {ok, numeroDescartado, serie}", async () => {
    espiar();
    const res = await app.inject({ method: "POST", url: URL, payload: { confirmar: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, numeroDescartado: 501, serie: 1 });
    expect(descartar).toHaveBeenCalledWith(TENANT, "nfe-1", true, "colab-1");
  });

  it.each([
    ["sem corpo", undefined],
    ["confirmar ausente", {}],
    ["confirmar 'true' (string)", { confirmar: "true" }],
  ])("%s ⇒ repassa confirmar=false", async (_nome, payload) => {
    espiar();
    await app.inject({ method: "POST", url: URL, ...(payload === undefined ? {} : { payload }) });
    expect(descartar).toHaveBeenCalledWith(TENANT, "nfe-1", false, "colab-1");
  });

  it("sem confirmação ⇒ 409 {error, code:NUMERACAO_CONFIRMAR_DESCARTE, detalhes:{numero, serie}}", async () => {
    espiar();
    descartar.mockRejectedValueOnce(new NumeracaoError("NUMERACAO_CONFIRMAR_DESCARTE", 409, "O nº 501 (série 1) está retido para conferência: confirme que ele NÃO foi autorizado na SEFAZ antes de descartá-lo", { numero: 501, serie: 1, motivo: "NUMERO_RETIDO_DESCARTADO" }));
    const res = await app.inject({ method: "POST", url: URL, payload: {} });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe("NUMERACAO_CONFIRMAR_DESCARTE");
    expect(body.error).toContain("NÃO foi autorizado na SEFAZ");
    expect(body.detalhes).toMatchObject({ numero: 501, serie: 1 });
  });

  it("reserva viva fora de BLOQUEADO ⇒ 409 {error, code:NUMERACAO_NAO_BLOQUEADA}", async () => {
    espiar();
    descartar.mockRejectedValueOnce(new NumeracaoError("NUMERACAO_NAO_BLOQUEADA", 409, "O número desta NF-e não está retido para conferência"));
    const res = await app.inject({ method: "POST", url: URL, payload: { confirmar: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "O número desta NF-e não está retido para conferência", code: "NUMERACAO_NAO_BLOQUEADA" });
  });

  it("nota inexistente ou de outro tenant ⇒ 404 {error}", async () => {
    espiar();
    descartar.mockRejectedValueOnce(new NumeracaoError("NFE_NAO_ENCONTRADA", 404, "NF-e não encontrada"));
    const res = await app.inject({ method: "POST", url: URL, payload: { confirmar: true } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "NF-e não encontrada" });
  });

  it("erro inesperado ⇒ 500 sem vazar detalhe do banco", async () => {
    espiar();
    descartar.mockRejectedValueOnce(new Error('relation "NfeNumeroReserva" does not exist'));
    const res = await app.inject({ method: "POST", url: URL, payload: { confirmar: true } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).not.toContain("relation");
  });

  it("colaborador com 'Notas fiscais' desligado ⇒ 403 sem chegar ao caso de uso", async () => {
    espiar();
    h.usuario = { id: "colab-2", parentUserId: TENANT, pagePermissions: { fiscal: false, pdv: true } };
    const res = await app.inject({ method: "POST", url: URL, payload: { confirmar: true } });
    expect(res.statusCode).toBe(403);
    expect(descartar).not.toHaveBeenCalled();
  });
});
