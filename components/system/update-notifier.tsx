"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Embutido no build (next.config.mjs -> env.NEXT_PUBLIC_BUILD_ID). É a versão
// que ESTE bundle carregado conhece; comparada com a do servidor a cada poll.
const CLIENT_VERSION = process.env.NEXT_PUBLIC_BUILD_ID ?? "";
const POLL_MS = 60_000; // checa a cada 60s
const SNOOZE_MS = 10 * 60_000; // "Agora não" adia por 10 min
// Guarda a versão em que já tentamos recarregar por erro de chunk (anti-loop).
const CHUNK_GUARD_KEY = "dexo:chunk-reload-version";

function isChunkError(message?: string | null): boolean {
  if (!message) return false;
  return (
    /ChunkLoadError/i.test(message) ||
    /Loading chunk [\w-]+ failed/i.test(message) ||
    /Loading CSS chunk/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message)
  );
}

export function UpdateNotifier() {
  const [open, setOpen] = useState(false);
  const snoozedUntil = useRef(0);

  const checkVersion = useCallback(async () => {
    if (!CLIENT_VERSION) return; // sem baseline → nada a comparar
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    )
      return;
    if (Date.now() < snoozedUntil.current) return;
    try {
      const res = await fetch(`/api/version?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { version?: string };
      if (data?.version && data.version !== CLIENT_VERSION) {
        setOpen(true);
      }
    } catch {
      /* rede instável: silencioso, tenta de novo no próximo ciclo */
    }
  }, []);

  // Poll por versão nova (só com aba visível) + checagem ao focar/voltar.
  useEffect(() => {
    const id = window.setInterval(checkVersion, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") checkVersion();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", checkVersion);
    const first = window.setTimeout(checkVersion, 3000); // deixa a página assentar
    return () => {
      window.clearInterval(id);
      window.clearTimeout(first);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", checkVersion);
    };
  }, [checkVersion]);

  // Safety net: erro de chunk (página antiga tentando baixar build novo).
  useEffect(() => {
    const handle = (message?: string | null) => {
      if (!isChunkError(message)) return;
      const guard = sessionStorage.getItem(CHUNK_GUARD_KEY);
      // Recarrega só se ainda NÃO tentamos recarregar nesta mesma versão.
      // Assim, se o reload trouxe um build novo, podemos recarregar de novo
      // (converge p/ o mais recente); se continuamos na MESMA versão quebrada,
      // não entra em loop — mostramos o modal.
      if (guard !== CLIENT_VERSION) {
        sessionStorage.setItem(CHUNK_GUARD_KEY, CLIENT_VERSION);
        window.location.reload();
      } else {
        setOpen(true);
      }
    };
    const onError = (e: ErrorEvent) =>
      handle(e?.message ?? (e?.error && e.error.message));
    const onRejection = (e: PromiseRejectionEvent) => {
      const r: unknown = e?.reason;
      handle(typeof r === "string" ? r : (r as { message?: string })?.message);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const reloadNow = () => window.location.reload();
  const snooze = () => {
    snoozedUntil.current = Date.now() + SNOOZE_MS;
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) snooze();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        // Só fecha pelos botões (evita fechar sem querer clicando fora/Esc).
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Nova atualização disponível</DialogTitle>
          <DialogDescription>
            Uma nova versão do Dexo foi publicada. Atualize a página para usar a
            versão mais recente e evitar erros. Suas próximas ações já entram na
            nova versão.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={snooze}>
            Agora não
          </Button>
          <Button onClick={reloadNow}>Atualizar agora</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
