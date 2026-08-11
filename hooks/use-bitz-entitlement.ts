"use client";

import * as React from "react";
import { useSession } from "next-auth/react";

import { getApiBaseUrl } from "@/lib/api";
import { AI_MODULE_ENABLED } from "@/components/bitz/bitz-constants";

/**
 * Sonda do gate por usuário do Bitz. Espelha o padrão do WhatsApp na sidebar
 * (components/app-sidebar.tsx:360-383): UMA chamada por montagem, só com a
 * flag global ligada, e estado inicial `false` para não haver flash do mascote
 * em tenant que não contratou.
 *
 * Com a flag desligada NENHUMA requisição é feita — o `return` vem antes.
 *
 * Não passa header manualmente: `components/api-auth-bridge.tsx` já injeta o
 * Bearer em toda URL que começa com `getApiBaseUrl()`. Por isso a URL é
 * montada por CONCATENAÇÃO de string (o patch casa por `startsWith`) e o
 * `fetch` é o global resolvido na hora da chamada.
 */
export function useBitzEntitlement(): boolean {
  const { data: session, status } = useSession();
  const [enabled, setEnabled] = React.useState(false);

  React.useEffect(() => {
    if (!AI_MODULE_ENABLED) return;
    if (status !== "authenticated" || !session?.user?.email) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/ai/entitlement`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setEnabled(Boolean(data?.enabled));
      } catch {
        // Sonda é best-effort: falhar aqui só mantém o mascote escondido.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status, session?.user?.email]);

  return enabled;
}
