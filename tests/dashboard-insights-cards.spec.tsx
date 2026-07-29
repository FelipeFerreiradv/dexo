import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

// vitest roda com `environment: "node"` (sem jsdom), então o recharts é mockado
// por completo — mesmo padrão de tests/listings-overview.spec.tsx. O que se
// testa aqui é o que o card DERIVA dos dados (rótulos, totais, percentuais),
// não o desenho do SVG.
vi.mock("recharts", () => {
  const Wrapper = ({ children }: any) => <div>{children}</div>;
  const NullComp = () => null;
  return {
    ResponsiveContainer: Wrapper,
    BarChart: Wrapper,
    PieChart: Wrapper,
    Bar: Wrapper,
    Pie: Wrapper,
    Cell: NullComp,
    XAxis: NullComp,
    YAxis: NullComp,
    CartesianGrid: NullComp,
    Tooltip: NullComp,
    Legend: NullComp,
  };
});

import {
  SalesByPlatformView,
  type SalesByPlatformResponse,
} from "../components/dashboard/insights/sales-by-platform-card";
import {
  SalesByCategoryView,
  type SalesByCategoryResponse,
} from "../components/dashboard/insights/sales-by-category-card";
import {
  SalesByPaymentMethodView,
  type SalesByPaymentMethodResponse,
} from "../components/dashboard/insights/sales-by-payment-method-card";
import {
  SalesByChannelView,
  type SalesByChannelResponse,
} from "../components/dashboard/insights/sales-by-channel-card";
import {
  categoryLeaf,
  categoryParent,
  fmtBRL,
  fmtPct,
  platformColor,
  rankColor,
  truncateLabel,
} from "../components/dashboard/insights/insight-theme";

const range = {
  startDate: "2026-07-01T00:00:00.000Z",
  endDate: "2026-07-31T23:59:59.999Z",
  label: "Últimos 30 dias",
  clamped: false,
};

/** Espaço fino/não-quebrável do Intl vira entidade no HTML do SSR. */
function normalize(html: string): string {
  // O React SSR insere `<!-- -->` entre duas expressões JSX adjacentes; sem
  // tirar isso, "40" + " un" nunca casa com "40 un".
  return normalizeSpaces(html.replace(/<!--\s*-->/g, ""));
}

function normalizeSpaces(html: string): string {
  return html.replace(/&#x27;/g, "'").replace(/ |&#x[0-9a-f]+;/gi, " ");
}

describe("insight-theme", () => {
  it("cor de plataforma é estável e desconhecida cai em OUTRO", () => {
    expect(platformColor("ML")).toBe(platformColor("ML"));
    expect(platformColor("ML")).not.toBe(platformColor("SHOPEE"));
    expect(platformColor("PLATAFORMA_NOVA")).toBe(platformColor("OUTRO"));
  });

  it("truncateLabel encurta nome longo de categoria", () => {
    expect(truncateLabel("Motor", 22)).toBe("Motor");
    expect(truncateLabel("A".repeat(40), 22)).toHaveLength(22);
  });

  it("categoryLeaf extrai a folha da hierarquia do marketplace", () => {
    // Sem isso, TODA categoria do ML vira "Acessórios para Veícu…" no eixo,
    // porque todas partem do mesmo prefixo.
    expect(
      categoryLeaf(
        "Acessórios para Veículos > Peças de Carros e Caminhonetes > Iluminação > Faróis",
      ),
    ).toBe("Faróis");
    expect(categoryLeaf("Motor e Peças > Motor")).toBe("Motor");
  });

  it("categoryLeaf tolera categoria simples, vazia e com espaços", () => {
    expect(categoryLeaf("Sem categoria")).toBe("Sem categoria");
    expect(categoryLeaf("A >  B  > ")).toBe("B");
    expect(categoryLeaf("")).toBe("");
  });

  it("categoryParent dá o nível acima, para desempatar folhas homônimas", () => {
    expect(categoryParent("A > B > Faróis")).toBe("B");
    expect(categoryParent("Motor")).toBeNull();
  });

  it("rankColor escurece do primeiro ao último e nunca sai da paleta", () => {
    const primeiro = rankColor(0, 5);
    const ultimo = rankColor(4, 5);
    expect(primeiro).not.toBe(ultimo);
    expect(primeiro).toContain("--color-chart-2");
    expect(ultimo).toContain("--color-chart-2");
    // Lista de um item não pode gerar divisão por zero.
    expect(rankColor(0, 1)).toContain("--color-chart-2");
  });

  it("formatadores não devolvem NaN", () => {
    expect(fmtBRL(Number.NaN)).toContain("0");
    expect(fmtPct(Number.NaN)).toBe("0,0%");
  });
});

describe("SalesByPlatformView", () => {
  const data: SalesByPlatformResponse = {
    range,
    totals: {
      orders: 120,
      revenue: 44000,
      cancelledOrders: 2,
      cancelledRevenue: 600,
    },
    byPlatform: [
      {
        platform: "ML",
        label: "Mercado Livre",
        orders: 90,
        revenue: 33000,
        cancelledOrders: 2,
        cancelledRevenue: 600,
        share: 75,
      },
      {
        platform: "SHOPEE",
        label: "Shopee",
        orders: 30,
        revenue: 11000,
        cancelledOrders: 0,
        cancelledRevenue: 0,
        share: 25,
      },
      {
        platform: "MAGALU",
        label: "Magalu",
        orders: 0,
        revenue: 0,
        cancelledOrders: 0,
        cancelledRevenue: 0,
        share: 0,
      },
    ],
  };

  it("lista as três plataformas com receita e participação", () => {
    const html = normalize(renderToString(<SalesByPlatformView data={data} />));
    expect(html).toContain("Mercado Livre");
    expect(html).toContain("Shopee");
    expect(html).toContain("Magalu");
    expect(html).toContain("90 pedidos");
    expect(html).toContain("75,0%");
  });

  it("plataforma zerada continua visível (legenda estável)", () => {
    const html = normalize(renderToString(<SalesByPlatformView data={data} />));
    expect(html).toContain("0 pedidos");
  });

  it("byPlatform vazio não quebra a renderização", () => {
    const html = renderToString(
      <SalesByPlatformView data={{ ...data, byPlatform: [] }} />,
    );
    expect(html).toBeTruthy();
  });
});

describe("SalesByCategoryView", () => {
  const data: SalesByCategoryResponse = {
    range,
    truncated: false,
    totals: { revenue: 30000, units: 150, orders: 90, categories: 27 },
    items: [
      {
        category: "Motor",
        revenue: 12000,
        units: 40,
        share: 40,
        isOther: false,
      },
      {
        category: "Sem categoria",
        revenue: 3000,
        units: 10,
        share: 10,
        isOther: false,
      },
      {
        category: "Outras",
        revenue: 15000,
        units: 100,
        share: 50,
        isOther: true,
      },
    ],
  };

  it("mostra as categorias, inclusive 'Sem categoria' e 'Outras'", () => {
    const html = normalize(renderToString(<SalesByCategoryView data={data} />));
    expect(html).toContain("Motor");
    expect(html).toContain("Sem categoria");
  });

  it("resumo traz unidades e percentual", () => {
    const html = normalize(renderToString(<SalesByCategoryView data={data} />));
    expect(html).toContain("40 un");
    expect(html).toContain("40,0%");
  });

  it("lista vazia não quebra", () => {
    const html = renderToString(
      <SalesByCategoryView data={{ ...data, items: [] }} />,
    );
    expect(html).toBeTruthy();
  });

  it("categoria hierárquica aparece pela folha, com o caminho no title", () => {
    // Caso real do Mercado Livre: sem o tratamento de folha, as duas linhas
    // ficariam idênticas no resumo ("Acessórios para Veícu…").
    const hierarquico: SalesByCategoryResponse = {
      ...data,
      items: [
        {
          category:
            "Acessórios para Veículos > Peças de Carros e Caminhonetes > Iluminação > Faróis",
          revenue: 5000,
          units: 20,
          share: 60,
          isOther: false,
        },
        {
          category:
            "Acessórios para Veículos > Aces. de Carros e Caminhonetes > Exterior > Alargadores de Pára-lama",
          revenue: 3000,
          units: 12,
          share: 40,
          isOther: false,
        },
      ],
    };

    const html = normalize(renderToString(<SalesByCategoryView data={hierarquico} />));
    expect(html).toContain("Faróis");
    expect(html).toContain("Alargadores de Pára-lama");
    // O caminho completo continua acessível no atributo title.
    expect(html).toContain("Iluminação");
    // E o prefixo repetido NÃO é o que rotula a barra.
    expect(html).not.toContain(">Acessórios para Veículos<");
  });

  it("folhas homônimas ganham o nível de cima como desempate", () => {
    const homonimas: SalesByCategoryResponse = {
      ...data,
      items: [
        {
          category: "Iluminação > Faróis",
          revenue: 100,
          units: 1,
          share: 50,
          isOther: false,
        },
        {
          category: "Sucata > Faróis",
          revenue: 100,
          units: 1,
          share: 50,
          isOther: false,
        },
      ],
    };

    const html = normalize(renderToString(<SalesByCategoryView data={homonimas} />));
    expect(html).toContain("Iluminação › Faróis");
    expect(html).toContain("Sucata › Faróis");
  });
});

describe("SalesByPaymentMethodView", () => {
  const data: SalesByPaymentMethodResponse = {
    range,
    totals: { total: 7500, pago: 7000, pendente: 500, vencido: 0, count: 25 },
    items: [
      {
        method: "PIX",
        label: "PIX",
        total: 6000,
        pago: 6000,
        pendente: 0,
        vencido: 0,
        count: 20,
        share: 80,
      },
      {
        method: null,
        label: "—",
        total: 1500,
        pago: 1000,
        pendente: 500,
        vencido: 0,
        count: 5,
        share: 20,
      },
    ],
  };

  it("renderiza a legenda com rótulo e percentual", () => {
    const html = normalize(
      renderToString(<SalesByPaymentMethodView data={data} />),
    );
    expect(html).toContain("PIX");
    expect(html).toContain("80,0%");
    expect(html).toContain("25 contas");
  });

  it("método nulo aparece como '—' e não derruba a lista (key duplicada)", () => {
    const html = normalize(
      renderToString(<SalesByPaymentMethodView data={data} />),
    );
    expect(html).toContain("—");
  });

  it("sem itens não quebra", () => {
    const html = renderToString(
      <SalesByPaymentMethodView data={{ ...data, items: [] }} />,
    );
    expect(html).toBeTruthy();
  });
});

describe("SalesByChannelView", () => {
  const data: SalesByChannelResponse = {
    range,
    totals: { total: 12000, pago: 8000, pendente: 3000, vencido: 1000, count: 42 },
    items: [
      {
        channel: "BALCAO",
        label: "Venda balcão",
        total: 9000,
        pago: 7000,
        pendente: 1500,
        vencido: 500,
        count: 30,
        share: 75,
      },
      {
        channel: "AVULSO",
        label: "A receber avulso",
        total: 3000,
        pago: 1000,
        pendente: 1500,
        vencido: 500,
        count: 12,
        share: 25,
      },
    ],
  };

  it("mostra a divisão percentual dos dois canais", () => {
    const html = normalize(renderToString(<SalesByChannelView data={data} />));
    expect(html).toContain("Venda balcão");
    expect(html).toContain("A receber avulso");
    expect(html).toContain("75,0%");
    expect(html).toContain("25,0%");
  });

  it("um canal ausente não impede o outro de renderizar", () => {
    const html = normalize(
      renderToString(
        <SalesByChannelView data={{ ...data, items: [data.items[0]] }} />,
      ),
    );
    expect(html).toContain("Venda balcão");
    expect(html).not.toContain("A receber avulso");
  });

  it("sem itens não quebra", () => {
    const html = renderToString(
      <SalesByChannelView data={{ ...data, items: [] }} />,
    );
    expect(html).toBeTruthy();
  });
});
