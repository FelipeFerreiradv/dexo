"use client";

import { AlertTriangle, CircleAlert } from "lucide-react";
import { useSession } from "next-auth/react";

import { mensagemDaConta } from "@/app/lib/account-health-messages";
import { useAccountHealth } from "@/components/system/use-account-health";

/**
 * "Contas com problema" dentro da aba de integração de uma plataforma.
 *
 * Existe porque a lista de contas da aba só mostra conta ATIVA: a conta parada
 * ou desconectada sumia sem aviso (ou a aba inteira caía em "não conectado").
 * Sem problema na plataforma devolve `null` e a aba fica como era.
 */
export function AccountProblemsBlock({ platform }: { platform: string }) {
  const { data: session } = useSession();
  const colaborador = Boolean((session?.user as any)?.parentUserId);
  // Sempre atual: a aba remonta este bloco logo depois de reconectar, e é
  // aqui que o aviso não pode continuar dizendo que a conta parou.
  const contas = useAccountHealth(session?.user?.email ?? null, {
    sempreAtual: true,
  }).filter(
    (c) => c.platform === platform,
  );

  if (!contas.length) return null;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Contas com problema</p>
      {contas.map((c) => {
        const msg = mensagemDaConta(c, {
          colaborador,
          naPaginaDaIntegracao: true,
        });
        const parada = c.tipo === "parada";
        return (
          <div
            key={c.id}
            role={parada ? "alert" : "status"}
            className={
              parada
                ? "flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2"
                : "flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2"
            }
          >
            {parada ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            )}
            <div className="min-w-0 text-sm">
              <p className="font-medium break-words">{msg.titulo}</p>
              {msg.detalhe ? (
                <p className="text-muted-foreground break-words">{msg.detalhe}</p>
              ) : null}
              {msg.acao?.tipo === "texto" ? (
                <p className="text-muted-foreground break-words">
                  {msg.acao.texto}
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
