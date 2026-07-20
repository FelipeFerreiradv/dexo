import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { assertPageAccess } from "@/app/lib/guard-page";
import { PageHeader } from "@/components/page-header";
import { OlxDashboard } from "./components/olx-dashboard";

export const metadata: Metadata = {
  title: "Integração OLX",
  description:
    "Gerencie a conexão, anúncios e sincronização de estoque com a OLX na plataforma Dexo.",
};

// Integração 100% aditiva atrás da flag. Com a flag desligada, a página não
// existe (mesmo por URL direta) — garante "flag off ⇒ app idêntico ao de hoje".
const OLX_ENABLED = process.env.NEXT_PUBLIC_OLX_INTEGRATION_ENABLED === "true";

export default async function OlxPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  if (!OLX_ENABLED) {
    notFound();
  }

  await assertPageAccess(session, "olx");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Integrações"
        title="OLX"
        subtitle="Gerencie a conexão, anúncios e sincronização de estoque com a OLX."
      />
      <OlxDashboard />
    </div>
  );
}
