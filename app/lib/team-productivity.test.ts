import { describe, it, expect } from "vitest";
import {
  aggregateBudgetsByVendedor,
  aggregateTeamProductivity,
  resolveProductivityRange,
  type BudgetVendedorRow,
  type ProductivityGroupRow,
} from "./team-productivity";

const collaborators = [
  { id: "u1", name: "Ana", email: "ana@x.com", avatarUrl: null },
  { id: "u2", name: "Bruno", email: "bruno@x.com", avatarUrl: null },
  { id: "u3", name: "Carla", email: "carla@x.com", avatarUrl: null },
];

function grp(
  userId: string,
  action: string,
  day: string,
  marketplace: string | null = null,
  count = 1,
): ProductivityGroupRow {
  return { userId, action, day, marketplace, count };
}

describe("aggregateTeamProductivity (grupos agregados no banco)", () => {
  it("conta produtos e split de anúncios por plataforma normalizada", () => {
    const groups: ProductivityGroupRow[] = [
      grp("u1", "CREATE_PRODUCT", "2026-06-10"),
      grp("u1", "CREATE_LISTING", "2026-06-10", "MercadoLivre"),
      grp("u1", "CREATE_LISTING", "2026-06-10", "SHOPEE"),
      grp("u2", "CREATE_LISTING", "2026-06-11", "Shopee"),
      grp("u2", "CREATE_LISTING", "2026-06-11", "MERCADO_LIVRE"),
      grp("u2", "CREATE_LISTING", "2026-06-11", "Amazon"), // → outro
    ];
    const res = aggregateTeamProductivity(groups, collaborators, {
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
    const { ml, shopee, outro, total } = res.totals.anuncios;
    expect(ml + shopee + outro).toBe(total);
  });

  it("soma o count de cada grupo (não conta 1 por linha)", () => {
    const res = aggregateTeamProductivity(
      [
        grp("u1", "CREATE_LISTING", "2026-06-10", "MercadoLivre", 7),
        grp("u1", "CREATE_PRODUCT", "2026-06-10", null, 3),
      ],
      collaborators,
      {
        startDate: new Date("2026-06-10T00:00:00Z"),
        endDate: new Date("2026-06-10T23:59:59Z"),
      },
    );
    expect(res.totals.produtos).toBe(3);
    expect(res.totals.anuncios.ml).toBe(7);
    const ana = res.byCollaborator.find((c) => c.id === "u1")!;
    expect(ana.produtos).toBe(3);
    expect(ana.anuncios.ml).toBe(7);
  });

  it("inclui o bucket 'outro' e nunca descarta anúncio sem plataforma", () => {
    const res = aggregateTeamProductivity(
      [
        grp("u1", "CREATE_LISTING", "2026-06-10", "MercadoLivre"),
        grp("u1", "CREATE_LISTING", "2026-06-10", null), // sem marketplace
      ],
      collaborators,
      {
        startDate: new Date("2026-06-10T00:00:00Z"),
        endDate: new Date("2026-06-10T23:59:59Z"),
      },
    );
    expect(res.totals.anuncios.total).toBe(2);
    expect(res.totals.anuncios.ml).toBe(1);
    expect(res.totals.anuncios.outro).toBe(1);
  });

  it("ranqueia por anúncios desc e inclui colaboradores sem atividade (zero)", () => {
    const res = aggregateTeamProductivity(
      [
        grp("u2", "CREATE_LISTING", "2026-06-10", "MercadoLivre", 2),
        grp("u1", "CREATE_LISTING", "2026-06-10", "SHOPEE", 1),
      ],
      collaborators,
      {
        startDate: new Date("2026-06-10T00:00:00Z"),
        endDate: new Date("2026-06-10T23:59:59Z"),
      },
    );
    expect(res.byCollaborator.map((c) => c.id)).toEqual(["u2", "u1", "u3"]);
    const carla = res.byCollaborator.find((c) => c.id === "u3")!;
    expect(carla.anuncios.total).toBe(0);
    expect(carla.lastActivityAt).toBeNull();
    expect(res.byCollaborator[0].lastActivityAt).not.toBeNull();
  });

  it("timeseries cobre todos os dias do intervalo (zeros incluídos)", () => {
    const res = aggregateTeamProductivity(
      [
        grp("u1", "CREATE_PRODUCT", "2026-06-10"),
        grp("u1", "CREATE_LISTING", "2026-06-12", "SHOPEE"),
      ],
      collaborators,
      {
        startDate: new Date("2026-06-10T00:00:00Z"),
        endDate: new Date("2026-06-12T23:59:59Z"),
      },
    );
    expect(res.timeseries.map((p) => p.date)).toEqual([
      "2026-06-10",
      "2026-06-11",
      "2026-06-12",
    ]);
    expect(res.timeseries[0]).toMatchObject({ produtos: 1, shopee: 0 });
    expect(res.timeseries[1]).toMatchObject({ produtos: 0, ml: 0, shopee: 0 });
    expect(res.timeseries[2]).toMatchObject({ shopee: 1 });
  });

  it("ignora grupos de userId desconhecido (defensivo)", () => {
    const res = aggregateTeamProductivity(
      [grp("intruso", "CREATE_LISTING", "2026-06-10", "MercadoLivre")],
      collaborators,
      {
        startDate: new Date("2026-06-10T00:00:00Z"),
        endDate: new Date("2026-06-10T23:59:59Z"),
      },
    );
    expect(res.totals.anuncios.total).toBe(0);
  });
});

describe("resolveProductivityRange", () => {
  const now = new Date("2026-06-25T15:00:00Z");

  it("sem parâmetros → últimos 30 dias", () => {
    const r = resolveProductivityRange(undefined, undefined, now);
    expect(r.label).toBe("Últimos 30 dias");
    expect(r.endDate.getTime()).toBe(now.getTime());
    expect(
      Math.round((r.endDate.getTime() - r.startDate.getTime()) / 86400000),
    ).toBe(30);
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

  it("borda de fuso: fim 'hoje' que ficou no passado (UTC) estende até agora", () => {
    // BRT 21:30 de 26/06 = 27/06 00:30Z. O usuário manda endDate=2026-06-26
    // (o "hoje" dele), que vira 2026-06-26T23:59:59.999Z — ATRÁS do agora real.
    const nowNight = new Date("2026-06-27T00:30:00.000Z");
    const r = resolveProductivityRange("2026-06-26", "2026-06-26", nowNight);
    // Fim estendido até o agora p/ não excluir o que acabou de ser criado.
    expect(r.endDate.getTime()).toBe(nowNight.getTime());
    // Rótulo continua mostrando a data escolhida (não "vaza" o clamp).
    expect(r.label).toBe("26/06/2026 a 26/06/2026");
  });

  it("borda de fuso: intervalo passado NÃO é estendido até agora", () => {
    const nowLater = new Date("2026-06-27T00:30:00.000Z");
    const r = resolveProductivityRange("2026-06-01", "2026-06-15", nowLater);
    // Fim a > 24h do agora: permanece o fim do dia escolhido.
    expect(r.endDate.toISOString()).toBe("2026-06-15T23:59:59.999Z");
  });
});

describe("aggregateBudgetsByVendedor", () => {
  const vendedores = [
    { id: "admin", name: "Dono", email: "dono@x.com", isOwner: true },
    { id: "u1", name: "Ana", email: "ana@x.com", isOwner: false },
    { id: "u2", name: "Bruno", email: "bruno@x.com", isOwner: false },
  ];

  it("soma emitidos e convertidos por vendedor + totais", () => {
    const rows: BudgetVendedorRow[] = [
      { vendedorId: "u1", count: 3, totalValue: 300, convertedCount: 1, convertedValue: 100 },
      { vendedorId: "u2", count: 2, totalValue: 250, convertedCount: 0, convertedValue: 0 },
      { vendedorId: "admin", count: 1, totalValue: 90, convertedCount: 1, convertedValue: 90 },
    ];
    const { totals, byVendedor } = aggregateBudgetsByVendedor(rows, vendedores);

    expect(totals.orcamentos).toEqual({ count: 6, valor: 640 });
    expect(totals.convertidos).toEqual({ count: 2, valor: 190 });

    const ana = byVendedor.find((v) => v.id === "u1")!;
    expect(ana.orcamentos).toEqual({ count: 3, valor: 300 });
    expect(ana.convertidos).toEqual({ count: 1, valor: 100 });

    // o admin entra como vendedor (isOwner) quando tem orçamento próprio.
    const dono = byVendedor.find((v) => v.id === "admin")!;
    expect(dono.isOwner).toBe(true);
    expect(dono.orcamentos.valor).toBe(90);
  });

  it("ordena por valor de orçamentos desc e inclui vendedores zerados", () => {
    const rows: BudgetVendedorRow[] = [
      { vendedorId: "u2", count: 1, totalValue: 500, convertedCount: 0, convertedValue: 0 },
    ];
    const { byVendedor } = aggregateBudgetsByVendedor(rows, vendedores);
    expect(byVendedor).toHaveLength(3); // todos listados, mesmo zerados
    expect(byVendedor[0].id).toBe("u2"); // maior valor primeiro
  });

  it("ignora vendedorId nulo ou fora do time (defensivo)", () => {
    const rows: BudgetVendedorRow[] = [
      { vendedorId: null, count: 9, totalValue: 999, convertedCount: 9, convertedValue: 999 },
      { vendedorId: "estranho", count: 5, totalValue: 555, convertedCount: 5, convertedValue: 555 },
      { vendedorId: "u1", count: 1, totalValue: 10, convertedCount: 0, convertedValue: 0 },
    ];
    const { totals } = aggregateBudgetsByVendedor(rows, vendedores);
    expect(totals.orcamentos).toEqual({ count: 1, valor: 10 }); // só u1 conta
  });
});
