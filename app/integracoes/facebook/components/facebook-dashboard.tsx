"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link2, RefreshCw, BarChart3, Info } from "lucide-react";
import { FacebookConnectionTab } from "./facebook-connection-tab";
import { FacebookListingsTab } from "./facebook-listings-tab";
import { FacebookSyncTab } from "./facebook-sync-tab";

export function FacebookDashboard() {
  return (
    <div className="space-y-4">
      {/* Catálogo Meta é unidirecional (Dexo → Facebook). Estoque 0 marca "out of
          stock" (item continua no catálogo, não some), e não há checkout no
          Brasil ⇒ sem pedido/mensagem/etiqueta. Deixar explícito no topo. */}
      <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          O Catálogo Meta permite publicar, editar e remover itens e baixar o
          estoque (Dexo → Facebook). Estoque zerado marca o item como{" "}
          <strong>indisponível</strong> (ele continua visível no catálogo, não é
          removido). A Meta <strong>não</strong> tem checkout no Brasil: não há
          pedido, cliente, mensagem nem etiqueta de envio automáticos. Vendas
          feitas pelo Facebook devem ser registradas manualmente como venda de
          balcão.
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
        <FacebookConnectionTab />
      </TabsContent>

      <TabsContent value="listings" className="space-y-4">
        <FacebookListingsTab />
      </TabsContent>

      <TabsContent value="sync" className="space-y-4">
        <FacebookSyncTab />
      </TabsContent>
      </Tabs>
    </div>
  );
}
