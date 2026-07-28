import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import Link from "next/link";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import prisma from "@/app/lib/prisma";
import { firstAllowedPage, pageHref, PAGE_DEFS } from "@/app/lib/page-access";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Sem acesso",
  description: "Nenhuma página liberada para este usuário.",
};

/**
 * Destino final de um colaborador sem NENHUMA página liberada.
 *
 * É terminal por construção, e isso é o que impede o loop de redirect:
 *  1. não tem PageId, então `hasPageAccess` nunca é consultada para ela;
 *  2. não está em PAGE_DEFS, então a UI de permissões não consegue desligá-la;
 *  3. não chama `assertPageAccess`, então é incapaz de emitir redirect.
 *
 * Por isso também NÃO redirecionamos daqui para a primeira página liberada
 * quando ela existe (caso de quem chegou digitando a URL): isso reintroduziria
 * um redirect nesta página e destruiria a propriedade (3). Em vez disso,
 * oferecemos um link — navegação por clique, nunca automática.
 */
export default async function SemAcessoPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const user = session.user as {
    id?: string;
    parentUserId?: string | null;
    role?: string | null;
  };

  let destino: string | null = null;
  let rotulo: string | null = null;
  if (user?.id) {
    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: { parentUserId: true, role: true, pagePermissions: true },
    });
    const alvo = firstAllowedPage({
      parentUserId: fresh?.parentUserId ?? user.parentUserId,
      role: fresh?.role ?? user.role,
      pagePermissions:
        (fresh?.pagePermissions as Record<string, boolean> | null) ?? null,
    });
    if (alvo) {
      destino = pageHref(alvo);
      rotulo = PAGE_DEFS.find((p) => p.id === alvo)?.label ?? null;
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Acesso" title="Sem acesso" />
      <div className="rounded-lg border border-border/60 bg-card p-6">
        <p className="text-sm text-muted-foreground">
          O administrador da conta não liberou nenhuma página para o seu
          usuário. Fale com ele para solicitar acesso.
        </p>
        {destino && rotulo ? (
          <p className="mt-4 text-sm">
            Você tem acesso a{" "}
            <Link
              href={destino}
              className="font-medium text-primary underline underline-offset-4"
            >
              {rotulo}
            </Link>
            .
          </p>
        ) : null}
      </div>
    </div>
  );
}
