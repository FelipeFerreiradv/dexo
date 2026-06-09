"use client";

import { LayoutGrid, List } from "lucide-react";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrapsList } from "./scraps-list";
import { ScrapsPipeline } from "./scraps-pipeline";
import { ScrapSearch } from "./scrap-search";

// Alterna entre a visão de pipeline (Kanban, nova) e a lista tabular existente.
// A lista permanece intacta — é renderizada exatamente como antes sob a aba "Lista".
export function ScrapsWorkspace() {
  return (
    <Tabs defaultValue="pipeline" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TabsList>
          <TabsTrigger value="pipeline">
            <LayoutGrid className="mr-2 h-4 w-4" />
            Pipeline
          </TabsTrigger>
          <TabsTrigger value="list">
            <List className="mr-2 h-4 w-4" />
            Lista
          </TabsTrigger>
        </TabsList>
        <ScrapSearch />
      </div>
      <TabsContent value="pipeline">
        <ScrapsPipeline />
      </TabsContent>
      <TabsContent value="list">
        <ScrapsList />
      </TabsContent>
    </Tabs>
  );
}
