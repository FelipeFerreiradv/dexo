"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

type CallbackStatus = "loading" | "success" | "error";

export default function MLCallbackPage() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<CallbackStatus>("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const processCallback = async () => {
      const code = searchParams.get("code");
      const state = searchParams.get("state");
      const error = searchParams.get("error");

      // Se ML retornou erro (usuário negou acesso, etc)
      if (error) {
        setStatus("error");
        setMessage(
          error === "access_denied"
            ? "Acesso negado. Você cancelou a autorização."
            : `Erro: ${error}`,
        );
        notifyParent("ML_OAUTH_ERROR", error);
        return;
      }

      // Verificar parâmetros obrigatórios
      if (!code || !state) {
        setStatus("error");
        setMessage("Parâmetros inválidos na URL de callback.");
        notifyParent("ML_OAUTH_ERROR", "Parâmetros inválidos");
        return;
      }

      try {
        // Chamar backend para processar o callback
        const response = await fetch(
          `http://localhost:3333/marketplace/ml/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || "Erro ao processar autenticação");
        }

        setStatus("success");
        setMessage("Conta conectada com sucesso!");
        notifyParent("ML_OAUTH_SUCCESS");

        // Fechar popup após 2 segundos
        setTimeout(() => {
          window.close();
        }, 2000);
      } catch (err) {
        setStatus("error");
        setMessage(
          err instanceof Error ? err.message : "Erro ao conectar conta",
        );
        notifyParent(
          "ML_OAUTH_ERROR",
          err instanceof Error ? err.message : "Erro desconhecido",
        );
      }
    };

    processCallback();
  }, [searchParams]);

  // Notifica janela pai (opener) sobre resultado
  const notifyParent = (type: string, message?: string) => {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type, message }, window.location.origin);
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
              Aguarde enquanto conectamos sua conta.
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
