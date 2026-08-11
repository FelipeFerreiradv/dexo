"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link2, RefreshCw, BarChart3, Info } from "lucide-react";
import { OlxConnectionTab } from "./olx-connection-tab";
import { OlxListingsTab } from "./olx-listings-tab";
import { OlxSyncTab } from "./olx-sync-tab";

export function OlxDashboard() {
  return (
    <div className="space-y-4">
      {/* A integração OLX é unidirecional (Dexo → OLX). Deixar isso explícito no
          topo evita que o usuário espere pedido/mensagem/etiqueta automáticos. */}
      <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          A OLX permite publicar, editar e remover anúncios e baixar o estoque
          (Dexo → OLX). Ela <strong>não</strong> devolve pedido, cliente,
          mensagem nem etiqueta de envio: a plataforma não tem API de checkout no
          Brasil. Vendas feitas na OLX devem ser registradas manualmente como
          venda de balcão — o anúncio sai do ar sozinho quando o estoque zera.
        </span>
      </div>

      <Tabs defaultValue="connection" className="space-y-4">
      <TabsList className="grid w-full grid-cols-3 rounded-full border border-border/60 bg-muted/20 p-1 lg:w-[480px]">
        <TabsTrigger
          value="connection"
          className="flex items-center gap-2 rounded-full data-[state=active]:bg-sidebar-accent/30"
        >
          <Link2 className="h-4 w-4" />
          <span className="hidden sm:inline">Conexão</span>
        </TabsTrigger>
        <TabsTrigger
          value="listings"
          className="flex items-center gap-2 rounded-full data-[state=active]:bg-sidebar-accent/30"
        >
          <BarChart3 className="h-4 w-4" />
          <span className="hidden sm:inline">Anúncios</span>
        </TabsTrigger>
        <TabsTrigger
          value="sync"
          className="flex items-center gap-2 rounded-full data-[state=active]:bg-sidebar-accent/30"
        >
          <RefreshCw className="h-4 w-4" />
          <span className="hidden sm:inline">Sincronização</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="connection" className="space-y-4">
        <OlxConnectionTab />
      </TabsContent>

      <TabsContent value="listings" className="space-y-4">
        <OlxListingsTab />
      </TabsContent>

      <TabsContent value="sync" className="space-y-4">
        <OlxSyncTab />
      </TabsContent>
      </Tabs>
    </div>
  );
}
