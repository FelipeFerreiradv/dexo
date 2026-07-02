import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { WhatsappConnection } from "./components/whatsapp-connection";

export const metadata: Metadata = {
  title: "Integração WhatsApp",
  description:
    "Conecte números do WhatsApp Business (Cloud API oficial da Meta) e atenda seus clientes pela aba de Mensagens do Dexo.",
};

// Módulo 100% aditivo atrás da flag (kill-switch global). Com a flag desligada,
// a página não existe (mesmo por URL direta) — "flag off ⇒ app idêntico".
// O gate POR USUÁRIO (plano pago) é verificado em runtime pelo componente,
// via GET /whatsapp/status — sem acesso, a página mostra o aviso de plano.
const WHATSAPP_ENABLED =
  process.env.NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED === "true";

export default async function WhatsappPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  if (!WHATSAPP_ENABLED) {
    notFound();
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Integrações"
        title="WhatsApp"
        subtitle="Conecte números do WhatsApp Business e atenda seus clientes pela aba de Mensagens."
      />
      <WhatsappConnection />
    </div>
  );
}
