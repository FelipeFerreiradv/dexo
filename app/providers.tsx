"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "@/components/theme-provider";
import { ApiAuthBridge } from "@/components/api-auth-bridge";
import { UpdateNotifier } from "@/components/system/update-notifier";
import { ReactNode } from "react";

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <SessionProvider
      // Mantém o session.apiToken (Bearer, exp 12h) renovado bem antes de
      // expirar: cada refetch re-executa o callback de sessão e re-emite o
      // token. Evita 401 no modo strict em abas deixadas abertas por muitas
      // horas (jornada longa). O refetch só re-decodifica o cookie JWE e
      // re-assina o JWT — sem consulta ao banco (zero egress Supabase).
      refetchInterval={60 * 60}
      refetchOnWindowFocus
    >
      {/* PR-A2: injeta o Bearer token nas chamadas à API (dentro do SessionProvider). */}
      <ApiAuthBridge />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        {/* Aviso global de nova versão + auto-recuperação de ChunkLoadError.
            Sem update detectado, renderiza só um Dialog fechado (nada visível). */}
        <UpdateNotifier />
        {children}
      </ThemeProvider>
    </SessionProvider>
  );
}
