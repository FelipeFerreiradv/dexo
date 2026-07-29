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

  // `min-w-0` em cada célula: item de grid tem `min-width: auto` por padrão e
  // se recusa a encolher abaixo do conteúdo — é o que faz um gráfico ou um
  // rótulo longo empurrar a coluna e criar rolagem horizontal na página.
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <section className="grid min-w-0 gap-4 xl:grid-cols-2">
        <div className="min-w-0">
          <SalesByPlatformCard />
        </div>
        <div className="min-w-0">
          <SalesByCategoryCard />
        </div>
      </section>
      <section className="grid min-w-0 gap-4 xl:grid-cols-2">
        <div className="min-w-0">
          <SalesByPaymentMethodCard />
        </div>
        <div className="min-w-0">
          <SalesByChannelCard />
        </div>
      </section>
    </div>
  );
}
