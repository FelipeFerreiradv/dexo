"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link2, RefreshCw, BarChart3 } from "lucide-react";
import { MLConnectionTab } from "./ml-connection-tab";
import { MLListingsTab } from "./ml-listings-tab";
import { MLSyncTab } from "./ml-sync-tab";

export function MLDashboard() {
  return (
    <Tabs defaultValue="connection" className="space-y-4">
      <TabsList className="grid w-full grid-cols-3 lg:w-[400px]">
        <TabsTrigger value="connection" className="flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          <span className="hidden sm:inline">Conexão</span>
        </TabsTrigger>
        <TabsTrigger value="listings" className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          <span className="hidden sm:inline">Anúncios</span>
        </TabsTrigger>
        <TabsTrigger value="sync" className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4" />
          <span className="hidden sm:inline">Sincronização</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="connection" className="space-y-4">
        <MLConnectionTab />
      </TabsContent>

      <TabsContent value="listings" className="space-y-4">
        <MLListingsTab />
      </TabsContent>

      <TabsContent value="sync" className="space-y-4">
        <MLSyncTab />
      </TabsContent>
    </Tabs>
  );
}
