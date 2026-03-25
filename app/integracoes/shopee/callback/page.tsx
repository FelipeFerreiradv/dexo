"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

type CallbackStatus = "loading" | "success" | "error";

export default function ShopeeCallbackPage() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<CallbackStatus>("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const processCallback = () => {
      // Verificar resultado vindo do redirect do backend
      const result = searchParams.get("result");
      const resultMessage = searchParams.get("message");

      if (result === "success") {
        setStatus("success");
        setMessage("Conta Shopee conectada com sucesso!");
        notifyParent("SHOPEE_OAUTH_SUCCESS");
        setTimeout(() => {
          window.close();
        }, 2000);
        return;
      }

      if (result === "error") {
        setStatus("error");
        setMessage(resultMessage || "Erro ao conectar conta Shopee");
        notifyParent(
          "SHOPEE_OAUTH_ERROR",
          resultMessage || "Erro desconhecido",
        );
        return;
      }

      // Fallback: parâmetros inesperados
      setStatus("error");
      setMessage("Parâmetros inválidos na URL de callback.");
      notifyParent("SHOPEE_OAUTH_ERROR", "Parâmetros inválidos");
    };

    processCallback();
  }, [searchParams]);

  // Notifica janela pai (opener) sobre resultado
  const notifyParent = (type: string, message?: string) => {
    if (
      typeof window !== "undefined" &&
      window.opener &&
      !window.opener.closed
    ) {
      try {
        const openerOrigin = new URL(window.opener.location.href).origin;
        window.opener.postMessage({ type, message }, openerOrigin);
      } catch (err) {
        console.warn("[Shopee Callback] Erro ao enviar postMessage:", err);
        try {
          window.opener.postMessage({ type, message }, "*");
        } catch (fallbackErr) {
          console.error(
            "[Shopee Callback] Fallback postMessage também falhou:",
            fallbackErr,
          );
        }
      }
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center shadow-lg">
        {status === "loading" && (
          <>
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-primary" />
            <h2 className="mt-4 text-lg font-semibold">Processando...</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Aguarde enquanto conectamos sua conta Shopee.
            </p>
          </>
        )}

        {status === "success" && (
          <>
            <CheckCircle2 className="mx-auto h-12 w-12 text-green-500" />
            <h2 className="mt-4 text-lg font-semibold text-green-700">
              Sucesso!
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">{message}</p>
            <p className="mt-4 text-xs text-muted-foreground">
              Esta janela fechará automaticamente...
            </p>
          </>
        )}

        {status === "error" && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-destructive" />
            <h2 className="mt-4 text-lg font-semibold text-destructive">
              Erro
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">{message}</p>
            <button
              onClick={() => window.close()}
              className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Fechar
            </button>
          </>
        )}
      </div>
    </div>
  );
}
