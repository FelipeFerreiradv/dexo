"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link2, RefreshCw, BarChart3 } from "lucide-react";
import { ShopeeConnectionTab } from "./shopee-connection-tab";
import { ShopeeListingsTab } from "./shopee-listings-tab";
import { ShopeeSyncTab } from "./shopee-sync-tab";

export function ShopeeDashboard() {
  return (
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
        <ShopeeConnectionTab />
      </TabsContent>

      <TabsContent value="listings" className="space-y-4">
        <ShopeeListingsTab />
      </TabsContent>

      <TabsContent value="sync" className="space-y-4">
        <ShopeeSyncTab />
      </TabsContent>
    </Tabs>
  );
}
