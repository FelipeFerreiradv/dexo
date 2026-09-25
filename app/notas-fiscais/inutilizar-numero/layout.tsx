import type { ReactNode } from "react";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/lib/auth";
import { assertPageAccess } from "@/app/lib/guard-page";

// Guarda de navegação da página "Notas fiscais" para esta rota. A page.tsx
// daqui é client component e não pode chamar assertPageAccess (lê o banco no
// servidor), por isso a guarda mora neste layout, que só envolve esta página.
//
// Só ACRESCENTA o bloqueio do colaborador com "Notas fiscais" desligado. Sem
// sessão ou com o módulo desligado, a página é entregue intacta e segue
// tratando esses casos no navegador como antes. A flag vem ANTES da permissão
// (ver page-access.ts). Travado em tests/fiscal/notas-fiscais-guarda-navegacao.spec.ts.
export default async function InutilizarNumeroLayout({
  children,
}: {
  children: ReactNode;
}) {
  if (process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED === "true") {
    const session = await getServerSession(authOptions);
    if (session) await assertPageAccess(session, "fiscal");
  }

  return children;
}
