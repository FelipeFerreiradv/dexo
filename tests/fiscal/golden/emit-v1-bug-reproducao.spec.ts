import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reprodução do salto de numeração no V1 (diagnóstico §1.2 do plano), dirigindo
// o NfeEmissionUseCase.emit REAL de ponta a ponta com o harness:
//  - NfeRepository REAL (é nele que mora a R1: updateDraft força DRAFT);
//  - CompanyFiscalRepository REAL, sobre o prisma em memória;
//  - prisma, NfeSequenceService, provider-factory, storage, DANFE e cliente
//    trocados pelos doubles do mundo (tests/fiscal/__harness__).
// Flag de reemissão ligada, como em produção.
//
// Estes testes DOCUMENTAM O DEFEITO: passam contra o código atual. A numeração
// V2 (flag por empresa) corrige; com a flag desligada eles têm de continuar
// passando — é a prova de regressão zero E de que o teste tem dentes.

// vi.hoisted: as fábricas do vi.mock sobem para o topo do arquivo; a função que
// carrega o mundo precisa subir junto (import LAZY, dentro da fábrica).
const W = vi.hoisted(() => () => import("../__harness__/emit-world").then((m) => m.world()));

vi.mock("../../../app/lib/prisma", async () => (await W()).modules.prisma);
vi.mock("@/app/lib/prisma", async () => (await W()).modules.prisma);
vi.mock("../../../app/fiscal/sequence/nfe-sequence.service", async () => (await W()).modules.sequenceV1);
vi.mock("../../../app/fiscal/providers/provider-factory", async () => (await W()).modules.providerFactory);
vi.mock("../../../app/fiscal/storage/fiscal-storage.service", async () => (await W()).modules.storage);
vi.mock("../../../app/fiscal/generators/danfe-pdf.service", async () => (await W()).modules.danfePdf);
vi.mock("../../../app/fiscal/generators/danfe-nfce-pdf.service", async () => (await W()).modules.danfeNfcePdf);
vi.mock("../../../app/repositories/customer.repository", async () => (await W()).modules.customerRepository);
vi.mock("../../../app/usecases/customer.usecase", async () => (await W()).modules.customerUseCase);

import { NfeEmissionUseCase } from "../../../app/usecases/nfe-emission.usecase";
import { NfeRepository } from "../../../app/repositories/nfe.repository";
import { world } from "../__harness__/emit-world";
import { passos } from "../__harness__/scripted-provider";

const w = world();

function cenario() {
  const cfg = w.seedConfig({ providerName: "SEFAZ_DIRECT" });
  w.seedAutorizada(100, { config: cfg });
  w.setProximoNumero(101, { config: cfg });
  const X = w.seedDraft({ config: cfg });
  return { cfg, X, uc: new NfeEmissionUseCase(), repo: new NfeRepository() };
}

describe("V1 (comportamento legado documentado — corrigido pela numeração V2)", () => {
  beforeEach(() => {
    w.reset();
    vi.stubEnv("NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED", "true");
    vi.stubEnv("SEFAZ_AUTO_FALLBACK_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_NFE_AUTO_CREATE_CUSTOMER", "false");
  });

  afterEach(() => {
    // Nenhum número duplicado, contador nunca recua, nada autorizado 2×.
    expect(w.checarInvariantes()).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("(a) 100 autorizada → X rejeitada 225 com nº 101 → edição (updateDraft) → retry autoriza com 102 (salto R1)", async () => {
    const { cfg, X, uc, repo } = cenario();

    w.provider.fila("emitir", passos.rejeitar(225, "Rejeicao: Falha no Schema XML da NFe", { autoridade: w.authority }));
    const r1 = await uc.emit(cfg.userId, X);
    expect(r1).toMatchObject({ success: false, status: "REJECTED", numero: 101, serie: 1 });
    expect(w.row(X)).toMatchObject({ status: "REJECTED", numero: 101, cStatRejeicao: 225 });
    expect(w.proximoNumero({ config: cfg })).toBe(102);

    // R1: qualquer salvamento do wizard reabre como DRAFT.
    await repo.updateDraft(cfg.userId, X, { informacoesComplementares: "cMun corrigido" });
    expect(w.row(X).status).toBe("DRAFT");

    w.provider.fila("emitir", passos.autorizar({ autoridade: w.authority }));
    const r2 = await uc.emit(cfg.userId, X);

    // O BUG: a mesma nota sai com 102; o 101 fica abandonado (rejeição não
    // consome número na SEFAZ) e o contador segue para 103.
    expect(r2).toMatchObject({ success: true, status: "AUTHORIZED", numero: 102 });
    expect(w.row(X)).toMatchObject({ status: "AUTHORIZED", numero: 102 });
    expect(w.proximoNumero({ config: cfg })).toBe(103);
    expect(w.numerada(X)).toEqual([101, 102]);
    expect(w.authority.numerosAutorizados({ serie: 1 })).toEqual([100, 102]);
    expect(w.audit(X)).toEqual([
      "NUMERADA",
      "ENVIADA",
      "REJEITADA",
      "NUMERADA",
      "ENVIADA",
      "AUTORIZADA",
    ]);
    expect(w.provider.ops()).toEqual(["emitir", "emitir"]);
  });

  it("(b) sem edição: rejeitada 225 → retry reaproveita o 101", async () => {
    const { cfg, X, uc } = cenario();

    w.provider.fila("emitir", passos.rejeitar(225, "Rejeicao: Falha no Schema XML da NFe", { autoridade: w.authority }));
    await uc.emit(cfg.userId, X);
    expect(w.row(X)).toMatchObject({ status: "REJECTED", numero: 101, cStatRejeicao: 225 });

    w.provider.fila("emitir", passos.autorizar({ autoridade: w.authority }));
    const r2 = await uc.emit(cfg.userId, X);

    expect(r2).toMatchObject({ status: "AUTHORIZED", numero: 101 });
    expect(w.proximoNumero({ config: cfg })).toBe(102);
    expect(w.numerada(X)).toEqual([101, 101]);
    expect(w.authority.numerosAutorizados({ serie: 1 })).toEqual([100, 101]);
    // Só uma reserva no contador: o retry reaproveitou sem chamar a sequência.
    expect(w.numeracao.reservas().map((r) => r.numero)).toEqual([101]);
  });

  it("(c) rejeitada 974 sem edição → retry sai com 102 (≥ 600 nunca reaproveita, R2)", async () => {
    const { cfg, X, uc } = cenario();

    w.provider.fila(
      "emitir",
      passos.rejeitar(974, "Rejeicao: CNPJ do responsavel tecnico nao autorizado", { autoridade: w.authority }),
    );
    await uc.emit(cfg.userId, X);
    expect(w.row(X)).toMatchObject({ status: "REJECTED", numero: 101, cStatRejeicao: 974 });

    w.provider.fila("emitir", passos.autorizar({ autoridade: w.authority }));
    const r2 = await uc.emit(cfg.userId, X);

    expect(r2).toMatchObject({ status: "AUTHORIZED", numero: 102 });
    expect(w.proximoNumero({ config: cfg })).toBe(103);
    expect(w.numerada(X)).toEqual([101, 102]);
    expect(w.authority.numerosAutorizados({ serie: 1 })).toEqual([100, 102]);
  });

  it("(d) storage.saveXmlOriginal lança depois da reserva → X volta a DRAFT com 101 → retry sai com 102 (R5)", async () => {
    const { cfg, X, uc } = cenario();

    w.storage.failNext("saveXmlOriginal", new Error("EACCES: disco sem permissão"));
    await expect(uc.emit(cfg.userId, X)).rejects.toThrow(/EACCES/);

    // Número já gravado na linha, mas a nota voltou a rascunho: nada foi enviado.
    expect(w.row(X)).toMatchObject({ status: "DRAFT", numero: 101 });
    expect(w.provider.chamadas).toHaveLength(0);
    expect(w.audit(X)).toEqual(["NUMERADA", "EDITADA_DRAFT"]);
    expect(w.proximoNumero({ config: cfg })).toBe(102);

    w.provider.fila("emitir", passos.autorizar({ autoridade: w.authority }));
    const r2 = await uc.emit(cfg.userId, X);

    expect(r2).toMatchObject({ status: "AUTHORIZED", numero: 102 });
    expect(w.proximoNumero({ config: cfg })).toBe(103);
    expect(w.numerada(X)).toEqual([101, 102]);
    expect(w.authority.numerosAutorizados({ serie: 1 })).toEqual([100, 102]);
  });
});
