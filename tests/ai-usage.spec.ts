import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  anexoQuotaMessage,
  anexoUsageProvider,
  audioUsageProvider,
  quotaMessage,
  refundAiAnexo,
  refundAiTurn,
  reserveAiAnexo,
  reserveAiTurn,
  tenantUsageProvider,
} from "../app/ai/quota/ai-usage.service";
import { AI_CONSTANTS } from "../app/ai/core/ai-constants";

// ===========================================================================
// Teto diário do Bitz. Reusa tryReserveDailySlot/refundDailySlot do pipeline de
// imagem — o incremento condicional atômico não é reescrito aqui.
//
// O `db` injetável (padrão de rembg-provider-usage.ts:41) é o que torna este
// spec um unit test puro, sem vi.mock e sem hoisting.
// ===========================================================================

function makeDb() {
  return {
    providerDailyUsage: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
  } as any;
}

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = "2026-08-07";

describe("tenantUsageProvider", () => {
  it("prefixa o tenant para não colidir com a linha global nem com o rembg", () => {
    expect(tenantUsageProvider("t1")).toBe("ai:tenant:t1");
    expect(AI_CONSTANTS.USAGE_PROVIDER_GLOBAL).toBe("ai:global");
  });
});

describe("reserveAiTurn", () => {
  let db: any;
  beforeEach(() => {
    db = makeDb();
  });

  it("reserva tenant E global: ok", async () => {
    db.providerDailyUsage.updateMany.mockResolvedValue({ count: 1 });

    const r = await reserveAiTurn({ dataOwnerId: "t1", db, now: NOW });

    expect(r.ok).toBe(true);
    expect(db.providerDailyUsage.updateMany).toHaveBeenCalledTimes(2);
  });

  it("reserva o TENANT primeiro (é o teto que bate na prática)", async () => {
    db.providerDailyUsage.updateMany.mockResolvedValue({ count: 1 });

    await reserveAiTurn({ dataOwnerId: "t1", db, now: NOW, maxPerTenant: 300 });

    expect(db.providerDailyUsage.updateMany.mock.calls[0][0]).toEqual({
      where: { provider: "ai:tenant:t1", day: DAY, count: { lt: 300 } },
      data: { count: { increment: 1 } },
    });
  });

  it("teto do tenant batido: nega e NÃO toca o contador global", async () => {
    // count:0 = nada atualizado; create falha = linha já existe no teto.
    db.providerDailyUsage.updateMany.mockResolvedValue({ count: 0 });
    db.providerDailyUsage.create.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    const r = await reserveAiTurn({ dataOwnerId: "t1", db, now: NOW });

    expect(r).toEqual({ ok: false, denied: "tenant" });
    // 2 chamadas: o increment inicial + o retry pós-P2002. Nenhuma no global.
    const providers = db.providerDailyUsage.updateMany.mock.calls.map(
      (c: any[]) => c[0].where.provider,
    );
    expect(providers.every((p: string) => p === "ai:tenant:t1")).toBe(true);
  });

  it("teto GLOBAL batido: nega e DEVOLVE o slot do tenant", async () => {
    let call = 0;
    db.providerDailyUsage.updateMany.mockImplementation(async () => {
      call += 1;
      // 1ª = tenant (ok). 2ª = global (teto). 3ª = refund do tenant.
      return { count: call === 1 ? 1 : 0 };
    });
    db.providerDailyUsage.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    const r = await reserveAiTurn({ dataOwnerId: "t1", db, now: NOW });

    expect(r).toEqual({ ok: false, denied: "global" });
    const refund = db.providerDailyUsage.updateMany.mock.calls.find(
      (c: any[]) => c[0].data?.count?.decrement === 1,
    );
    expect(refund).toBeTruthy();
    expect(refund[0].where.provider).toBe("ai:tenant:t1");
    // Mesmo dia da reserva: sem isso, uma virada de meia-noite UTC entre
    // reservar e devolver decrementaria o contador do dia NOVO.
    expect(refund[0].where.day).toBe(DAY);
  });

  it("erro de banco no contador: NEGA (fail-closed, não deixa passar sem contar)", async () => {
    db.providerDailyUsage.updateMany.mockRejectedValue(new Error("db caiu"));
    db.providerDailyUsage.create.mockRejectedValue(new Error("db caiu"));

    const r = await reserveAiTurn({ dataOwnerId: "t1", db, now: NOW });

    expect(r.ok).toBe(false);
  });

  it("dataOwnerId vazio: nega sem tocar o banco", async () => {
    const r = await reserveAiTurn({ dataOwnerId: "", db, now: NOW });

    expect(r.ok).toBe(false);
    expect(db.providerDailyUsage.updateMany).not.toHaveBeenCalled();
  });
});

describe("refundAiTurn", () => {
  it("devolve as DUAS linhas e nunca lança", async () => {
    const db = makeDb();
    db.providerDailyUsage.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      refundAiTurn({ dataOwnerId: "t1", db, now: NOW }),
    ).resolves.toBeUndefined();

    const providers = db.providerDailyUsage.updateMany.mock.calls.map(
      (c: any[]) => c[0].where.provider,
    );
    expect(providers).toEqual(["ai:tenant:t1", "ai:global"]);
  });

  it("falha do banco no refund não propaga (teto fica conservador)", async () => {
    const db = makeDb();
    db.providerDailyUsage.updateMany.mockRejectedValue(new Error("db caiu"));

    await expect(
      refundAiTurn({ dataOwnerId: "t1", db, now: NOW }),
    ).resolves.toBeUndefined();
  });
});

describe("quotaMessage", () => {
  it("distingue teto do cliente e teto da plataforma, sem jargão", () => {
    expect(quotaMessage("tenant")).toMatch(/limite/i);
    expect(quotaMessage("global")).toMatch(/demanda/i);
    expect(quotaMessage("tenant")).not.toMatch(/quota|tenant|global/i);
  });
});

// ---------------------------------------------------------------------------
// Fase 8 — a leitura de ANEXO tem contador próprio.
// ---------------------------------------------------------------------------
describe("cota de anexo", () => {
  it("⭐⭐ TRÊS contadores distintos: mensagem, áudio e anexo", () => {
    // Esta é a garantia que sustenta a fase inteira. Trocar a foto até sair
    // legível é comportamento normal, e não pode gastar as mensagens do dia —
    // do mesmo jeito que regravar o áudio não gasta.
    const t = "t1";
    const chaves = [
      tenantUsageProvider(t),
      audioUsageProvider(t),
      anexoUsageProvider(t),
    ];
    expect(chaves).toEqual(["ai:tenant:t1", "ai:audio:t1", "ai:anexo:t1"]);
    expect(new Set(chaves).size).toBe(3);
    expect(chaves).not.toContain(AI_CONSTANTS.USAGE_PROVIDER_GLOBAL);
  });

  it("reserva a linha do tenant e a global, nesta ordem", async () => {
    const db = makeDb();
    db.providerDailyUsage.updateMany.mockResolvedValue({ count: 1 });

    const r = await reserveAiAnexo({ dataOwnerId: "t1", db, now: NOW });

    expect(r.ok).toBe(true);
    const chamadas = db.providerDailyUsage.updateMany.mock.calls.map(
      (c: any[]) => c[0].where,
    );
    expect(chamadas[0].provider).toBe("ai:anexo:t1");
    expect(chamadas[0].day).toBe(DAY);
    expect(chamadas[1].provider).toBe("ai:global");
  });

  it("⭐ teto global fechado devolve o slot do anexo — ele não gastou nada", async () => {
    const db = makeDb();
    let call = 0;
    db.providerDailyUsage.updateMany.mockImplementation(async () => {
      call += 1;
      // 1ª = anexo (ok). 2ª = global (teto batido). 3ª = devolução do anexo.
      return { count: call === 1 ? 1 : 0 };
    });
    db.providerDailyUsage.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    const r = await reserveAiAnexo({ dataOwnerId: "t1", db, now: NOW });

    expect(r).toEqual({ ok: false, denied: "global" });
    const refund = db.providerDailyUsage.updateMany.mock.calls.find(
      (c: any[]) => c[0].data?.count?.decrement === 1,
    );
    expect(refund).toBeTruthy();
    expect(refund[0].where.provider).toBe("ai:anexo:t1");
    // Mesmo dia da reserva: com um `new Date()` novo, a virada de meia-noite
    // UTC decrementaria o contador do dia seguinte.
    expect(refund[0].where.day).toBe(DAY);
  });

  it("erro de banco NEGA (fail-closed), em vez de deixar passar sem contar", async () => {
    const db = makeDb();
    db.providerDailyUsage.updateMany.mockRejectedValue(new Error("db caiu"));
    db.providerDailyUsage.create.mockRejectedValue(new Error("db caiu"));

    const r = await reserveAiAnexo({ dataOwnerId: "t1", db, now: NOW });
    expect(r.ok).toBe(false);
  });

  it("dataOwnerId vazio: nega sem tocar o banco", async () => {
    const db = makeDb();
    const r = await reserveAiAnexo({ dataOwnerId: "", db, now: NOW });

    expect(r.ok).toBe(false);
    expect(db.providerDailyUsage.updateMany).not.toHaveBeenCalled();
  });

  it("⭐ o refund devolve as DUAS linhas — a do anexo E a global", async () => {
    // ⚠️ Este teste já foi FRACO: ele só verificava que a promessa resolvia, com
    // o banco rejeitando tudo. Apagar o refund da linha global passava. Em
    // produção isso vazaria teto: toda foto ilegível (o caso comum, e
    // justamente o que devolve a cota) devolveria o slot do tenant e NÃO o
    // global, e o contador da plataforma subiria sozinho o dia inteiro.
    const db = makeDb();
    db.providerDailyUsage.updateMany.mockResolvedValue({ count: 1 });

    await refundAiAnexo({ dataOwnerId: "t1", db, now: NOW });

    const providers = db.providerDailyUsage.updateMany.mock.calls.map(
      (c: any[]) => c[0].where.provider,
    );
    expect(providers).toEqual(["ai:anexo:t1", "ai:global"]);
    // Decremento, não incremento — e no dia da reserva.
    for (const c of db.providerDailyUsage.updateMany.mock.calls) {
      expect(c[0].data.count.decrement).toBe(1);
      expect(c[0].where.day).toBe(DAY);
    }
  });

  it("o refund nunca lança, mesmo com o banco fora", async () => {
    const db = makeDb();
    db.providerDailyUsage.updateMany.mockRejectedValue(new Error("db caiu"));

    await expect(
      refundAiAnexo({ dataOwnerId: "t1", db, now: NOW }),
    ).resolves.toBeUndefined();
  });

  it("a mensagem de teto fala de FOTO e lembra que escrever continua liberado", () => {
    expect(anexoQuotaMessage("tenant")).toMatch(/fotos/i);
    expect(anexoQuotaMessage("tenant")).toMatch(/escrever/i);
    expect(anexoQuotaMessage("global")).toMatch(/demanda/i);
    expect(anexoQuotaMessage("tenant")).not.toMatch(/quota|tenant|global/i);
  });
});
