import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { CollaboratorsTab } from "./components/collaborators-tab";

export const metadata: Metadata = {
  title: "Colaboradores",
  description:
    "Auditoria das ações realizadas pelos colaboradores vinculados à sua conta.",
};

export default async function ColaboradoresPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  // Colaboradores (usuários com parentUserId) não devem ver esta página.
  // Backend também valida via /me/team/activity (403).
  if ((session.user as any)?.parentUserId) {
    redirect("/");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Equipe"
        title="Colaboradores"
        subtitle="Histórico de ações realizadas pelos seus colaboradores na plataforma."
      />

      <CollaboratorsTab />
    </div>
  );
}
