/**
 * `NfeDraftUseCase.descartarNumeroBloqueado` (rota POST /fiscal/nfe/:id/numeracao/descartar-bloqueado)
 * com o DDL da V2 ausente: o ledger não existe, logo não há reserva BLOQUEADO para descartar. O caso
 * de uso responde 409 NUMERACAO_NAO_BLOQUEADA (a mesma resposta de "nota sem reserva"), nunca 500
 * com o erro do banco. Qualquer outro erro sobe como veio. Lacuna apontada na revisão do G1: o
 * mapeamento não tinha teste porque o IT de Postgres sempre aplica o DDL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ nota: { id: "nfe-1" } as { id: string } | null }));
vi.mock("../../../app/lib/prisma", () => ({
  default: { nfeEmitida: { findFirst: async () => h.nota } },
}));

import { NfeDraftUseCase } from "../../../app/usecases/nfe-draft.usecase";
import { NfeNumeracaoService } from "../../../app/fiscal/numeracao/numeracao.service";

afterEach(() => { vi.restoreAllMocks(); h.nota = { id: "nfe-1" }; });

describe("descartarNumeroBloqueado sem o DDL da V2", () => {
  it.each([
    ["P2021 (Prisma: tabela não existe)", { code: "P2021" }],
    ["42P01 (Postgres: relation does not exist)", { code: "P2010", meta: { code: "42P01" } }],
  ])("%s ⇒ 409 NUMERACAO_NAO_BLOQUEADA", async (_nome, erro) => {
    vi.spyOn(NfeNumeracaoService.prototype, "descartarNumeroBloqueado").mockRejectedValue(Object.assign(new Error("relation \"NfeNumeroReserva\" does not exist"), erro));
    await expect(new NfeDraftUseCase().descartarNumeroBloqueado("tenant", "nfe-1", true)).rejects.toMatchObject({ code: "NUMERACAO_NAO_BLOQUEADA", httpStatus: 409 });
  });

  it("outro erro de banco SOBE como veio (não vira 'não bloqueada')", async () => {
    const outro = Object.assign(new Error("connection reset"), { code: "P1017" });
    vi.spyOn(NfeNumeracaoService.prototype, "descartarNumeroBloqueado").mockRejectedValue(outro);
    await expect(new NfeDraftUseCase().descartarNumeroBloqueado("tenant", "nfe-1", true)).rejects.toBe(outro);
  });

  it("nota inexistente ⇒ 404 antes de tocar no ledger", async () => {
    h.nota = null;
    const espiao = vi.spyOn(NfeNumeracaoService.prototype, "descartarNumeroBloqueado");
    await expect(new NfeDraftUseCase().descartarNumeroBloqueado("tenant", "nfe-x", true)).rejects.toMatchObject({ code: "NFE_NAO_ENCONTRADA", httpStatus: 404 });
    expect(espiao).not.toHaveBeenCalled();
  });
});
