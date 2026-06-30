"use client";

// Orchestrator for the read-only "Prévia" wizard step.
//
// Builds a normalized view-model from the form values and renders a faithful,
// read-only preview of the marketplace listing(s) the user opted to create:
//   - nenhum marcado   → estado vazio amigável
//   - exatamente um     → aquele mock direto (sem abas)
//   - mais de um        → abas por marketplace (1º como default)
//
// This step is PURELY VISUAL: it never creates/edits/publishes anything and
// never mutates form/business state.

import React from "react";
import { Eye } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { MlListingPreview } from "./ml-listing-preview";
import { ShopeeListingPreview } from "./shopee-listing-preview";
import { MagaluListingPreview } from "./magalu-listing-preview";
import {
  buildPreviewViewModel,
  type PreviewFormValues,
  type PreviewAccount,
  type PreviewCompatibility,
  type CategoryOption,
} from "./preview-utils";

export interface StepPreviewProps {
  values: PreviewFormValues;
  compatibilities: PreviewCompatibility[];
  mlAccounts: PreviewAccount[];
  shopeeAccounts: PreviewAccount[];
  selectedMlAccountIds: string[];
  selectedShopeeAccountIds: string[];
  mlOptions: CategoryOption[];
  shopeeOptions: CategoryOption[];
  formatCurrency: (value: number | null | undefined) => string;
  // Magalu (opcionais — só usados com a flag ligada).
  magaluAccounts?: PreviewAccount[];
  selectedMagaluAccountIds?: string[];
}

export function StepPreview({
  values,
  compatibilities,
  mlAccounts,
  shopeeAccounts,
  selectedMlAccountIds,
  selectedShopeeAccountIds,
  mlOptions,
  shopeeOptions,
  formatCurrency,
  magaluAccounts = [],
  selectedMagaluAccountIds = [],
}: StepPreviewProps) {
  const vm = buildPreviewViewModel({
    values,
    compatibilities,
    mlAccounts,
    shopeeAccounts,
    selectedMlAccountIds,
    selectedShopeeAccountIds,
    mlOptions,
    shopeeOptions,
    formatCurrency,
    magaluAccounts,
    selectedMagaluAccountIds,
  });

  // Marketplaces ativos (na ordem de exibição). Cada um vira aba/preview.
  const previews: Array<{
    value: string;
    label: string;
    iconSrc?: string;
    node: React.ReactNode;
  }> = [];
  if (vm.showML)
    previews.push({
      value: "ml",
      label: "Mercado Livre",
      iconSrc: "/marketplaces/mercado-livre.svg",
      node: <MlListingPreview vm={vm} />,
    });
  if (vm.showShopee)
    previews.push({
      value: "shopee",
      label: "Shopee",
      iconSrc: "/marketplaces/shopee.svg",
      node: <ShopeeListingPreview vm={vm} />,
    });
  if (vm.showMagalu)
    previews.push({
      value: "magalu",
      label: "Magalu",
      node: <MagaluListingPreview vm={vm} />,
    });

  // Nenhum marketplace marcado → estado vazio amigável.
  if (previews.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/30 p-10 text-center">
        <Eye className="h-10 w-10 text-muted-foreground" />
        <div>
          <p className="font-medium">Nada para pré-visualizar</p>
          <p className="text-sm text-muted-foreground">
            Você não marcou criar anúncio em nenhum marketplace, então não há
            prévia para exibir. É só seguir para a Revisão.
          </p>
        </div>
      </div>
    );
  }

  const intro = (
    <p className="text-sm text-muted-foreground">
      Confira como o anúncio vai aparecer. Esta é apenas uma prévia visual —
      nada é publicado nesta etapa.
    </p>
  );

  // Apenas um marketplace marcado → mostra direto, sem abas.
  if (previews.length === 1) {
    return (
      <div className="space-y-3">
        {intro}
        {previews[0].node}
      </div>
    );
  }

  // Mais de um → abas (o 1º ativo como default).
  return (
    <div className="space-y-3">
      {intro}
      <Tabs defaultValue={previews[0].value} className="w-full">
        <TabsList>
          {previews.map((p) => (
            <TabsTrigger key={p.value} value={p.value} className="gap-2">
              {p.iconSrc && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={p.iconSrc} alt="" className="h-4 w-4" />
              )}
              {p.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {previews.map((p) => (
          <TabsContent key={p.value} value={p.value}>
            {p.node}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
