"use client";

import { SalesByCategoryCard } from "./sales-by-category-card";
import { SalesByChannelCard } from "./sales-by-channel-card";
import { SalesByPaymentMethodCard } from "./sales-by-payment-method-card";
import { SalesByPlatformCard } from "./sales-by-platform-card";

/**
 * Bloco de gráficos analíticos do Dashboard, cada card com seu próprio filtro.
 *
 * Flag de BUILD-TIME (padrão do repo: `NEXT_PUBLIC_*` lida em const de módulo,
 * como PDV e NF-e). Ligar exige setar a variável E rebuildar — não basta
 * reiniciar o processo. Desligada, este componente não renderiza nada e o
 * Dashboard fica byte-idêntico ao que está em produção hoje.
 */
const DASHBOARD_INSIGHTS_ENABLED =
  process.env.NEXT_PUBLIC_DASHBOARD_INSIGHTS_ENABLED === "true";

export function DashboardInsights() {
  if (!DASHBOARD_INSIGHTS_ENABLED) return null;

  return (
    <div className="flex flex-col gap-4">
      <section className="grid gap-4 xl:grid-cols-2">
        <SalesByPlatformCard />
        <SalesByCategoryCard />
      </section>
      <section className="grid gap-4 xl:grid-cols-2">
        <SalesByPaymentMethodCard />
        <SalesByChannelCard />
      </section>
    </div>
  );
}
