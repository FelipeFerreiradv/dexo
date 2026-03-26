import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("recharts", () => {
  const React = require("react");
  const Wrapper = ({ children }: any) => <div>{children}</div>;
  const NullComp = () => null;
  return {
    ResponsiveContainer: Wrapper,
    LineChart: Wrapper,
    Line: NullComp,
    CartesianGrid: NullComp,
    XAxis: NullComp,
    YAxis: NullComp,
    Tooltip: NullComp,
  };
});

import {
  ListingsOverview,
  type ListingStats,
} from "../components/dashboard/listings-overview";

const baseStats: ListingStats = {
  totalListings: 0,
  totalListingsActive: 0,
  perAccount: [],
  timeline: { global: [], perAccount: {} },
};

describe("ListingsOverview component", () => {
  it("renders empty state safely", () => {
    const html = renderToString(<ListingsOverview stats={baseStats} />);
    expect(html).toContain("Sem anúncios");
  });

  it("shows account rows when data is provided", () => {
    const stats: ListingStats = {
      ...baseStats,
      perAccount: [
        {
          accountId: "acc-1",
          accountName: "Loja A",
          platform: "MERCADO_LIVRE",
          status: "ACTIVE",
          totalListings: 5,
        },
      ],
      timeline: {
        global: [{ date: "2024-01-01", count: 2 }],
        perAccount: { "acc-1": [{ date: "2024-01-01", count: 2 }] },
      },
    };

    const html = renderToString(<ListingsOverview stats={stats} />);
    expect(html).toContain("Loja A");
    expect(html).toContain("5");
  });
});
