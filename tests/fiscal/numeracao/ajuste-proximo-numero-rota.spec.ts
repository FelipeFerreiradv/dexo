import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Contrato HTTP de POST /fiscal/nfe/proximo-numero/ajuste — o que a tela
// consome. Aqui o caso de uso é dublê: o que está sob teste é a rota (caminho,
// escopo do tenant vindo do auth, fronteira de tipo do emitente e a tradução
// do NumeracaoError para {error, code, detalhes} com o httpStatus do domínio).
//
// O corpo do ajuste é validado no caso de uso (ajuste-proximo-numero.spec.ts),
// não aqui — a rota não duplica regra de domínio.

const ATOR = "colaborador-1";
const TENANT = "tenant-mk2";

vi.mock("../../../app/lib/prisma", () => ({ default: {} }));
vi.mock("@/app/lib/prisma", () => ({ default: {} }));
vi.mock("../../../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    // Colaborador: id próprio (o ATOR) e dataOwnerId do dono dos dados.
    request.user = { id: ATOR, dataOwnerId: TENANT };
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { NumeracaoError } from "../../../app/fiscal/numeracao/numeracao.errors";
import { fiscalRoutes } from "../../../app/routes/fiscal.routes";
import { NfeSequenceAjusteUseCase } from "../../../app/usecases/nfe-sequence-ajuste.usecase";

const URL = "/fiscal/nfe/proximo-numero/ajuste";
const CORPO = {
  companyFiscalConfigId: "cfg-matriz",
  ambiente: "PRODUCAO",
  modelo: "55",
  serie: 1,
  proximoNumero: 5000,
  motivo: "cliente informou que o ultimo numero no sistema anterior foi 4999",
  confirmar: true,
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(fiscalRoutes, { prefix: "/fiscal" });
  await app.ready();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /fiscal/nfe/proximo-numero/ajuste", () => {
  it("aplica e devolve o ajuste, com o tenant e o ator do request", async () => {
    const ajustar = vi
      .spyOn(NfeSequenceAjusteUseCase.prototype, "ajustar")
      .mockResolvedValue({
        companyFiscalConfigId: "cfg-matriz",
        emitenteDocumento: "11222333000181",
        ambiente: "PRODUCAO",
        modelo: "55",
        serie: 1,
        proximoNumeroAnterior: 100,
        proximoNumero: 5000,
        numerosPulados: 4900,
        motivo: CORPO.motivo,
        ajustadoEm: "2026-09-23T12:00:00.000Z",
      });

    const res = await app.inject({ method: "POST", url: URL, payload: CORPO });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      ajuste: { proximoNumeroAnterior: 100, proximoNumero: 5000, numerosPulados: 4900 },
    });
    // O escopo do tenant vem do auth, NUNCA do corpo.
    expect(ajustar).toHaveBeenCalledTimes(1);
    const [userId, input, contexto] = ajustar.mock.calls[0];
    expect(userId).toBe(TENANT);
    expect(input).toMatchObject({
      companyFiscalConfigId: "cfg-matriz",
      ambiente: "PRODUCAO",
      modelo: "55",
      serie: 1,
      proximoNumero: 5000,
      confirmar: true,
    });
    expect(contexto?.atorUserId).toBe(ATOR);
  });

  it("sem confirmação, devolve o 409 do domínio com code e detalhes", async () => {
    vi.spyOn(NfeSequenceAjusteUseCase.prototype, "ajustar").mockRejectedValue(
      new NumeracaoError(
        "NUMERACAO_CONFIRMAR_AJUSTE",
        409,
        "…4900 número(s) ficarão sem uso…",
        { numerosPulados: 4900, proximoNumeroAtual: 100 },
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: URL,
      payload: { ...CORPO, confirmar: false },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: "NUMERACAO_CONFIRMAR_AJUSTE",
      detalhes: { numerosPulados: 4900, proximoNumeroAtual: 100 },
    });
    expect(res.json().error).toContain("4900");
  });

  it("emitente de tipo inválido é 400 e não chega ao caso de uso", async () => {
    const ajustar = vi.spyOn(NfeSequenceAjusteUseCase.prototype, "ajustar");

    const res = await app.inject({
      method: "POST",
      url: URL,
      payload: { ...CORPO, companyFiscalConfigId: { id: "cfg-matriz" } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Emitente inválido" });
    expect(ajustar).not.toHaveBeenCalled();
  });

  it("emitente ausente vira null (CNPJ padrão), não string vazia", async () => {
    const ajustar = vi
      .spyOn(NfeSequenceAjusteUseCase.prototype, "ajustar")
      .mockRejectedValue(
        new NumeracaoError("CONFIG_FISCAL_AUSENTE", 409, "Configuração fiscal não encontrada"),
      );

    const { companyFiscalConfigId, ...semEmitente } = CORPO;
    const res = await app.inject({ method: "POST", url: URL, payload: semEmitente });

    expect(res.statusCode).toBe(409);
    expect(ajustar.mock.calls[0][1].companyFiscalConfigId).toBeNull();
  });
});
