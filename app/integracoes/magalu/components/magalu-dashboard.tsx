"use client";

import { MagaluConnectionTab } from "./magalu-connection-tab";

/**
 * Dashboard da integração Magalu.
 *
 * Entrega B: apenas a aba de Conexão. As abas de Anúncios e Sincronização
 * (espelhando ML) entram nas Entregas C/F, quando os respectivos tabs
 * existirem — momento em que isto vira um <Tabs> de 3 abas como o MLDashboard.
 */
export function MagaluDashboard() {
  return (
    <div className="space-y-4">
      <MagaluConnectionTab />
    </div>
  );
}
