"use client";

// Orchestrator for the read-only "Prévia" wizard step.
//
// Builds a normalized view-model from the form values and renders a faithful,
// read-only preview of the marketplace listing(s) the user opted to create:
//   - neither marketplace marked  → friendly empty state
//   - exactly one marked          → that mock directly (no tabs)
//   - both marked                 → ML/Shopee tabs (default ML)
//
// This step is PURELY VISUAL: it never creates/edits/publishes anything and
// never mutates form/business state.

import React from "react";
import { Eye } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { MlListingPreview } from "./ml-listing-preview";
import { ShopeeListingPreview } from "./shopee-listing-preview";
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
  });

  // Nenhum marketplace marcado → estado vazio amigável.
  if (!vm.showML && !vm.showShopee) {
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
  if (vm.showML && !vm.showShopee) {
    return (
      <div className="space-y-3">
        {intro}
        <MlListingPreview vm={vm} />
      </div>
    );
  }
  if (vm.showShopee && !vm.showML) {
    return (
      <div className="space-y-3">
        {intro}
        <ShopeeListingPreview vm={vm} />
      </div>
    );
  }

  // Ambos marcados → abas, ML por padrão.
  return (
    <div className="space-y-3">
      {intro}
      <Tabs defaultValue="ml" className="w-full">
        <TabsList>
          <TabsTrigger value="ml" className="gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/marketplaces/mercado-livre.svg"
              alt=""
              className="h-4 w-4"
            />
            Mercado Livre
          </TabsTrigger>
          <TabsTrigger value="shopee" className="gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/marketplaces/shopee.svg" alt="" className="h-4 w-4" />
            Shopee
          </TabsTrigger>
        </TabsList>
        <TabsContent value="ml">
          <MlListingPreview vm={vm} />
        </TabsContent>
        <TabsContent value="shopee">
          <ShopeeListingPreview vm={vm} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
