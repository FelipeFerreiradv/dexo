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

  // Rotas que NÃO recebem o MainLayout (Sidebar, Header).
  //
  // Além do login, os documentos legais públicos. O motivo é concreto: o
  // `AppSidebar` e o `AppHeader` fazem `router.push("/login")` sempre que a
  // sessão é nula (app-sidebar.tsx e app-header.tsx), então QUALQUER rota que
  // passe pelo MainLayout expulsa o visitante anônimo — mesmo servindo HTTP 200
  // com o conteúdo inteiro.
  //
  // Isso quebra exatamente o que a Meta exige de /privacidade: o rastreador
  // dela, que não executa JavaScript, via a política e aprovava; um revisor
  // humano abrindo o mesmo link era jogado para o login e concluía o oposto.
  // Medido em navegador anônimo: /termos carregava e terminava em /login.
  //
  // A correção é aqui, e não no redirect do sidebar/header: aquele redirect
  // está certo para as telas do sistema e continua intacto.
  const ROTAS_PUBLICAS = ["/login", "/privacidade", "/termos"];
  if (
    ROTAS_PUBLICAS.some(
      (rota) => pathname === rota || pathname.startsWith(`${rota}/`),
    )
  ) {
    return <>{children}</>;
  }

  // Para outras páginas, aplicar o MainLayout completo
  return <MainLayout session={session}>{children}</MainLayout>;
}
