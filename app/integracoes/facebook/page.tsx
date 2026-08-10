import { redirect, notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { assertPageAccess } from "@/app/lib/guard-page";
import { PageHeader } from "@/components/page-header";
import { FacebookDashboard } from "./components/facebook-dashboard";

export const metadata: Metadata = {
  title: "Integração Facebook",
  description:
    "Gerencie a conexão, anúncios e sincronização de estoque com o catálogo do Facebook/Meta na plataforma Dexo.",
};

// Integração 100% aditiva atrás da flag. Com a flag desligada, a página não
// existe (mesmo por URL direta) — garante "flag off ⇒ app idêntico ao de hoje".
const FACEBOOK_ENABLED =
  process.env.NEXT_PUBLIC_FACEBOOK_INTEGRATION_ENABLED === "true";

export default async function FacebookPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  if (!FACEBOOK_ENABLED) {
    notFound();
  }

  await assertPageAccess(session, "facebook");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Integrações"
        title="Facebook"
        subtitle="Gerencie a conexão, o catálogo e a sincronização de estoque com o Facebook/Meta."
      />
      <FacebookDashboard />
    </div>
  );
}
