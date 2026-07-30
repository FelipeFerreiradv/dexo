import { describe, expect, it, vi } from "vitest";

import {
  refundDailySlot,
  tryReserveDailySlot,
  utcDayKey,
} from "../app/marketplaces/services/rembg-provider-usage";

function makeDb() {
  return {
    providerDailyUsage: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
  } as any;
}

describe("rembg-provider-usage (teto diário)", () => {
  it("utcDayKey é o dia UTC em YYYY-MM-DD", () => {
    expect(utcDayKey(new Date("2026-07-30T23:59:59Z"))).toBe("2026-07-30");
    expect(utcDayKey(new Date("2026-07-31T00:00:01Z"))).toBe("2026-07-31");
  });

  it("teto <= 0 (default do env) NUNCA reserva nem toca o banco", async () => {
    const db = makeDb();
    expect(
      await tryReserveDailySlot({ provider: "p", maxPerDay: 0, db }),
    ).toBe(false);
    expect(db.providerDailyUsage.updateMany).not.toHaveBeenCalled();
    expect(db.providerDailyUsage.create).not.toHaveBeenCalled();
  });

  it("linha do dia existe com folga: increment condicional reserva", async () => {
    const db = makeDb();
    db.providerDailyUsage.updateMany.mockResolvedValue({ count: 1 });
    const ok = await tryReserveDailySlot({
      provider: "photoroom",
      maxPerDay: 50,
      db,
      now: new Date("2026-07-30T12:00:00Z"),
    });
    expect(ok).toBe(true);
    expect(db.providerDailyUsage.updateMany).toHaveBeenCalledWith({
      where: {
        provider: "photoroom",
        day: "2026-07-30",
        count: { lt: 50 },
      },
      data: { count: { increment: 1 } },
    });
    expect(db.providerDailyUsage.create).not.toHaveBeenCalled();
  });

  it("primeiro uso do dia: cria a linha com count=1", async () => {
    const db = makeDb();
    db.providerDailyUsage.updateMany.mockResolvedValue({ count: 0 });
    db.providerDailyUsage.create.mockResolvedValue({});
    const ok = await tryReserveDailySlot({ provider: "p", maxPerDay: 5, db });
    expect(ok).toBe(true);
    expect(db.providerDailyUsage.create).toHaveBeenCalledWith({
      data: { provider: "p", day: utcDayKey(), count: 1 },
    });
  });

  it("corrida do primeiro-do-dia: create bate no unique e o retry decide", async () => {
    const db = makeDb();
    db.providerDailyUsage.updateMany
      .mockResolvedValueOnce({ count: 0 }) // linha ainda não existia
      .mockResolvedValueOnce({ count: 1 }); // retry pós-P2002 reserva
    db.providerDailyUsage.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    const ok = await tryReserveDailySlot({ provider: "p", maxPerDay: 5, db });
    expect(ok).toBe(true);
    expect(db.providerDailyUsage.updateMany).toHaveBeenCalledTimes(2);
  });

  it("teto batido: increment não casa, create bate no unique, retry devolve false", async () => {
    const db = makeDb();
    db.providerDailyUsage.updateMany.mockResolvedValue({ count: 0 });
    db.providerDailyUsage.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    const ok = await tryReserveDailySlot({ provider: "p", maxPerDay: 3, db });
    expect(ok).toBe(false);
  });

  it("refund decrementa com guarda count>0 e nunca lança", async () => {
    const db = makeDb();
    db.providerDailyUsage.updateMany.mockResolvedValue({ count: 1 });
    await refundDailySlot({ provider: "p", db });
    expect(db.providerDailyUsage.updateMany).toHaveBeenCalledWith({
      where: { provider: "p", day: utcDayKey(), count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    });

    db.providerDailyUsage.updateMany.mockRejectedValue(new Error("pooler"));
    await expect(
      refundDailySlot({ provider: "p", db }),
    ).resolves.toBeUndefined();
  });
});
