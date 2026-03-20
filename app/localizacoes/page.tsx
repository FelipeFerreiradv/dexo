import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { LocationsList } from "./components/locations-list";

export const metadata: Metadata = {
  title: "Localizações",
  description:
    "Gerencie as localizações físicas do estoque. Cadastre galpões, prateleiras e subdivisões para organizar seus produtos.",
};

export default async function LocationsPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Estoque"
        title="Localizações"
        subtitle="Gerencie os locais de armazenamento físico. Cadastre galpões, prateleiras e subdivisões para organizar seus produtos."
      />

      <LocationsList />
    </div>
  );
}
