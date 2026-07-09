import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { assertPageAccess } from "@/app/lib/guard-page";
import { PageHeader } from "@/components/page-header";
import { MagaluDashboard } from "./components/magalu-dashboard";

export const metadata: Metadata = {
  title: "Integração Magalu",
  description:
    "Gerencie a conexão, anúncios e sincronização de estoque com a Magalu na plataforma Dexo.",
};

// Integração 100% aditiva atrás da flag. Com a flag desligada, a página não
// existe (mesmo por URL direta) — garante "flag off ⇒ app idêntico ao de hoje".
const MAGALU_ENABLED =
  process.env.NEXT_PUBLIC_MAGALU_INTEGRATION_ENABLED === "true";

export default async function MagaluPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  if (!MAGALU_ENABLED) {
    notFound();
  }

  await assertPageAccess(session, "magalu");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Integrações"
        title="Magalu"
        subtitle="Gerencie a conexão, anúncios e sincronização de estoque com a Magalu."
      />
      <MagaluDashboard />
    </div>
  );
}
