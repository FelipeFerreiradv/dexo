"use client";

import React from "react";
import { Session } from "next-auth";

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/app-header";
import { AccountHealthBanner } from "@/components/system/account-health-banner";

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
        {/* Conta de marketplace parada ou desconectada com anúncio à venda.
            Sem problema devolve null e o layout fica idêntico. */}
        <AccountHealthBanner session={session} />
        <main className="flex-1 min-w-0 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
