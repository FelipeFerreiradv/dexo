import { describe, it, expect } from "vitest";
import {
  aggregateTeamProductivity,
  resolveProductivityRange,
  type ProductivityLogRow,
} from "./team-productivity";

const collaborators = [
  { id: "u1", name: "Ana", email: "ana@x.com", avatarUrl: null },
  { id: "u2", name: "Bruno", email: "bruno@x.com", avatarUrl: null },
  { id: "u3", name: "Carla", email: "carla@x.com", avatarUrl: null },
];

function row(
  userId: string,
  action: string,
  createdAt: string,
  marketplace?: string,
): ProductivityLogRow {
  return {
    userId,
    action,
    details: marketplace ? { marketplace } : { productData: {} },
    createdAt: new Date(createdAt),
  };
}

describe("aggregateTeamProductivity", () => {
  it("conta produtos e split de anúncios por plataforma normalizada", () => {
    const rows: ProductivityLogRow[] = [
      row("u1", "CREATE_PRODUCT", "2026-06-10T12:00:00Z"),
      row("u1", "CREATE_LISTING", "2026-06-10T13:00:00Z", "MercadoLivre"),
      row("u1", "CREATE_LISTING", "2026-06-10T14:00:00Z", "SHOPEE"),
      row("u2", "CREATE_LISTING", "2026-06-11T10:00:00Z", "Shopee"),
      row("u2", "CREATE_LISTING", "2026-06-11T11:00:00Z", "MERCADO_LIVRE"),
      row("u2", "CREATE_LISTING", "2026-06-11T12:00:00Z", "Amazon"), // → outro
    ];
    const res = aggregateTeamProductivity(rows, collaborators, {
      startDate: new Date("2026-06-10T00:00:00Z"),
      endDate: new Date("2026-06-11T23:59:59Z"),
    });

    expect(res.totals.produtos).toBe(1);
    expect(res.totals.anuncios).toEqual({
      total: 5,
      ml: 2,
      shopee: 2,
      outro: 1,
    });
    // soma dos buckets de plataforma = total (nada é descartado)
    const { ml, shopee, outro, total } = res.totals.anuncios;
    expect(ml + shopee + outro).toBe(total);
  });

  it("inclui o bucket 'outro' e nunca descarta anúncio sem plataforma", () => {
    const rows = [
      row("u1", "CREATE_LISTING", "2026-06-10T13:00:00Z", "MercadoLivre"),
      row("u1", "CREATE_LISTING", "2026-06-10T14:00:00Z"), // sem marketplace
    ];
    const res = aggregateTeamProductivity(rows as ProductivityLogRow[], collaborators, {
      startDate: new Date("2026-06-10T00:00:00Z"),
      endDate: new Date("2026-06-10T23:59:59Z"),
    });
    expect(res.totals.anuncios.total).toBe(2);
    expect(res.totals.anuncios.ml).toBe(1);
    expect(res.totals.anuncios.outro).toBe(1);
  });

  it("ranqueia por anúncios desc e inclui colaboradores sem atividade (zero)", () => {
    const rows = [
      row("u2", "CREATE_LISTING", "2026-06-10T10:00:00Z", "MercadoLivre"),
      row("u2", "CREATE_LISTING", "2026-06-10T11:00:00Z", "MercadoLivre"),
      row("u1", "CREATE_LISTING", "2026-06-10T12:00:00Z", "SHOPEE"),
    ];
    const res = aggregateTeamProductivity(rows, collaborators, {
      startDate: new Date("2026-06-10T00:00:00Z"),
      endDate: new Date("2026-06-10T23:59:59Z"),
    });
    expect(res.byCollaborator.map((c) => c.id)).toEqual(["u2", "u1", "u3"]);
    const carla = res.byCollaborator.find((c) => c.id === "u3")!;
    expect(carla.anuncios.total).toBe(0);
    expect(carla.lastActivityAt).toBeNull();
    expect(res.byCollaborator[0].lastActivityAt).not.toBeNull();
  });

  it("timeseries cobre todos os dias do intervalo (zeros incluídos)", () => {
    const rows = [
      row("u1", "CREATE_PRODUCT", "2026-06-10T12:00:00Z"),
      row("u1", "CREATE_LISTING", "2026-06-12T12:00:00Z", "SHOPEE"),
    ];
    const res = aggregateTeamProductivity(rows, collaborators, {
      startDate: new Date("2026-06-10T00:00:00Z"),
      endDate: new Date("2026-06-12T23:59:59Z"),
    });
    expect(res.timeseries.map((p) => p.date)).toEqual([
      "2026-06-10",
      "2026-06-11",
      "2026-06-12",
    ]);
    expect(res.timeseries[0]).toMatchObject({ produtos: 1, shopee: 0 });
    expect(res.timeseries[1]).toMatchObject({ produtos: 0, ml: 0, shopee: 0 });
    expect(res.timeseries[2]).toMatchObject({ shopee: 1 });
  });

  it("ignora linhas de userId desconhecido (defensivo)", () => {
    const rows = [
      row("intruso", "CREATE_LISTING", "2026-06-10T10:00:00Z", "MercadoLivre"),
    ];
    const res = aggregateTeamProductivity(rows, collaborators, {
      startDate: new Date("2026-06-10T00:00:00Z"),
      endDate: new Date("2026-06-10T23:59:59Z"),
    });
    expect(res.totals.anuncios.total).toBe(0);
  });
});

describe("resolveProductivityRange", () => {
  const now = new Date("2026-06-25T15:00:00Z");

  it("sem parâmetros → últimos 30 dias", () => {
    const r = resolveProductivityRange(undefined, undefined, now);
    expect(r.label).toBe("Últimos 30 dias");
    expect(r.endDate.getTime()).toBe(now.getTime());
    expect(Math.round((r.endDate.getTime() - r.startDate.getTime()) / 86400000)).toBe(30);
  });

  it("datas YYYY-MM-DD viram início e fim do dia", () => {
    const r = resolveProductivityRange("2026-06-01", "2026-06-15", now);
    expect(r.startDate.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(r.endDate.toISOString()).toBe("2026-06-15T23:59:59.999Z");
    expect(r.label).toBe("01/06/2026 a 15/06/2026");
  });

  it("entrada inválida cai no default sem lançar", () => {
    const r = resolveProductivityRange("nonsense", undefined, now);
    expect(r.label).toBe("Últimos 30 dias");
  });
});
