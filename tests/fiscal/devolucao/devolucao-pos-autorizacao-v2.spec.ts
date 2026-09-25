/**
 * G4 #4 / N-completude-3: os passos da devolução DEPOIS da autorização
 * (`NfeDevolucaoUseCase.registrarAutorizacao`: vínculo na original, conferência do
 * excesso e o evento DEVOLUCAO_AUTORIZADA) só rodavam em `finalizar`. Uma queda entre o
 * commit AUTHORIZED e o fim de `finalizar` — ou uma falha só da devolução — e o replay
 * (`completarPosAutorizacao`) nunca mais os fazia.
 *
 * O que foi CONFERIDO antes de mexer (e fica preso aqui): o SALDO da nota original NÃO
 * depende disto. `linhasSaldo` lê o status da NOTA de devolução (NfeEmitida.status, que
 * registrarResposta/registrarConsulta gravam no mesmo commit da autorização), não os
 * eventos. Então uma devolução autorizada consome saldo — e trava o cancelamento da
 * original — mesmo se registrarAutorizacao nunca rodar. O que se perdia era o histórico
 * (DEVOLUCAO_VINCULADA na original, DEVOLUCAO_SALDO_EXCEDIDO, DEVOLUCAO_AUTORIZADA).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig, makeDraft } from "../__helpers__/test-draft";

const h = vi.hoisted(() => ({
  hookFeito: false,
  registradas: [] as Array<[string, string]>,
  falharRegistro: false,
  logs: [] as string[],
}));

vi.mock("../../../app/lib/prisma", () => ({
  default: {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes(`"evento"='AUTORIZADA'`)) return h.hookFeito ? [{ x: 1 }] : [];
      if (sql.includes(`"protocoloAutorizacao"`)) return [{ protocoloAutorizacao: "142260000000712", dataAutorizacao: null }];
      throw new Error("SQL não emulado: " + sql.slice(0, 80));
    },
    $executeRawUnsafe: async () => 0,
  },
}));
vi.mock("../../../app/usecases/nfe-devolucao.usecase", () => ({
  NfeDevolucaoUseCase: class {
    async registrarAutorizacao(userId: string, id: string) {
      if (h.falharRegistro) throw new Error("banco fora");
      h.registradas.push([userId, id]);
    }
  },
}));
vi.mock("../../../app/fiscal/numeracao/log", () => ({ logNumeracao: (evento: string) => { h.logs.push(evento); } }));

import { NfeEmissaoV2Orchestrator } from "../../../app/usecases/nfe-emissao-v2.orchestrator";

const CFC = "cfg-dls";
const CHAVE_DEV = "42260957502966000144550010000007151123456780";

function montar(o: { reserva?: "AUTORIZADO" | null } = {}) {
  const config = makeConfig({ id: CFC, userId: "tenant", providerName: "SEFAZ_DIRECT", isDefault: true });
  const devolucao = makeDraft({ id: "dev-715", userId: "tenant", companyFiscalConfigId: CFC, status: "AUTHORIZED", finalidade: "DEVOLUCAO", tipoOperacao: "SAIDA", numero: 715, chaveAcesso: CHAVE_DEV });
  const reserva = o.reserva === null ? null : { id: "r-715", estado: "AUTORIZADO", numero: 715, serie: 1, ambiente: "PRODUCAO", companyFiscalConfigId: CFC };
  const numeros = { reservaViva: async () => reserva, focusRefAutorizada: async () => null };
  const repo = { findNfeById: async () => devolucao };
  const autorizado = vi.fn(async () => ({}) as never);
  const uc = new NfeEmissaoV2Orchestrator({ validar: () => {}, snapshot: () => ({}), autorizado }, numeros as never, repo as never, {} as never);
  return { uc, config, devolucao, autorizado };
}

beforeEach(() => {
  h.hookFeito = false; h.registradas = []; h.falharRegistro = false; h.logs = [];
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
  vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", CFC);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("replay de devolução AUTORIZADA (completarPosAutorizacao) registra a autorização da devolução", () => {
  it("XML/DANFE já concluídos e só a devolução pendente (a falha de antes): o replay chama registrarAutorizacao", async () => {
    h.hookFeito = true;
    const { uc, config, devolucao, autorizado } = montar();
    const r = await uc.emitir("tenant", devolucao, config);
    expect(r).toMatchObject({ success: true, status: "AUTHORIZED" });
    expect(autorizado).not.toHaveBeenCalled();
    expect(h.registradas).toEqual([["tenant", "dev-715"]]);
  });

  it("queda antes de tudo: o replay refaz o hook E a devolução", async () => {
    const { uc, config, devolucao, autorizado } = montar();
    await uc.emitir("tenant", devolucao, config);
    expect(autorizado).toHaveBeenCalledTimes(1);
    expect(h.registradas).toEqual([["tenant", "dev-715"]]);
  });

  it("falha da devolução no replay não derruba a resposta (a nota já está autorizada) e fica no log", async () => {
    h.hookFeito = true; h.falharRegistro = true;
    const { uc, config, devolucao } = montar();
    await expect(uc.emitir("tenant", devolucao, config)).resolves.toMatchObject({ success: true });
    expect(h.logs).toContain("devolucao_pos_autorizacao_pendente");
  });

  it("CONTROLE: empresa sem a devolução ligada não chama nada da devolução", async () => {
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", "outra");
    h.hookFeito = true;
    const { uc, config, devolucao } = montar();
    await uc.emitir("tenant", devolucao, config);
    expect(h.registradas).toEqual([]);
  });

  it("CONTROLE: sem reserva AUTORIZADO (nada a completar), nada da devolução", async () => {
    const { uc, config, devolucao } = montar({ reserva: null });
    await uc.emitir("tenant", devolucao, config);
    expect(h.registradas).toEqual([]);
  });
});
