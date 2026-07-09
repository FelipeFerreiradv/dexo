import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { assertPageAccess } from "@/app/lib/guard-page";
import { PageHeader } from "@/components/page-header";
import { MessagesShell } from "./components/messages-shell";

export const metadata: Metadata = {
  title: "Mensagens",
  description:
    "Caixa unificada de perguntas dos seus anúncios no Mercado Livre. Responda direto da Dexo.",
};

export default async function MensagensPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  await assertPageAccess(session, "mensagens");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Atendimento"
        title="Mensagens"
        subtitle="Responda perguntas pré-venda dos seus anúncios sem sair da Dexo. Histórico completo por conversa, sincronizado com o Mercado Livre."
      />
      <MessagesShell userEmail={session.user?.email ?? ""} />
    </div>
  );
}
