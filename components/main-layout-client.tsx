"use client";

import { usePathname } from "next/navigation";
import { Session } from "next-auth";
import React from "react";
import { MainLayout } from "@/components/main-layout";

interface MainLayoutClientProps {
  children: React.ReactNode;
  session: Session | null;
}

export function MainLayoutClient({ children, session }: MainLayoutClientProps) {
  const pathname = usePathname();

  // Se estiver na página de login, não aplicar MainLayout (Sidebar, Header)
  if (pathname === "/login" || pathname.startsWith("/login/")) {
    return <>{children}</>;
  }

  // Para outras páginas, aplicar o MainLayout completo
  return <MainLayout session={session}>{children}</MainLayout>;
}
