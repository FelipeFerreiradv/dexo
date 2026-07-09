import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { assertPageAccess } from "@/app/lib/guard-page";
import { LogsView } from "./components/logs-view";

export const metadata: Metadata = {
  title: "Logs",
  description:
    "Auditoria de eventos do sistema — filtros por usuário, ação, recurso e nível.",
};

/**
 * Wrapper server: aplica o guard de sessão + a permissão por página (Entrega C)
 * antes de renderizar a view client (que faz o fetch dos logs). O corpo client
 * original foi movido para ./components/logs-view.tsx sem alterações de lógica.
 */
export default async function LogsPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  await assertPageAccess(session, "logs");

  return <LogsView />;
}
