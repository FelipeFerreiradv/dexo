"use client";

import React from "react";
import { Session } from "next-auth";

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { BitzRoot } from "@/components/bitz/bitz-root";

interface MainLayoutProps {
  children: React.ReactNode;
  session: Session | null;
}

export function MainLayout({ children, session }: MainLayoutProps) {
  return (
    <SidebarProvider>
      <AppSidebar session={session} />
      <SidebarInset>
        <AppHeader session={session} />
        <main className="flex-1 min-w-0 p-4 md:p-6">{children}</main>
      </SidebarInset>
      {/* Bitz (agente de IA). Fica FORA do SidebarInset de propósito: aquele
          elemento É o <main>, e um widget global dentro dele poluiria o
          landmark. Como é `position: fixed`, sai do fluxo flex e não desloca,
          redimensiona nem faz refluir nada — o layout é byte-idêntico.
          Retorna null sem a flag de build, sem sessão ou sem o plano. */}
      <BitzRoot session={session} />
    </SidebarProvider>
  );
}
