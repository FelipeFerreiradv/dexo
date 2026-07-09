"use client";

import { useMemo, useState } from "react";
import { Copy, CheckCircle2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const DEFAULT_REDIRECT_URI =
  "https://api.usedexo.com.br/marketplace/ml/callback";

/**
 * POSIX double-quote seguro: envolve o valor em aspas e escapa os metacaracteres
 * que ainda são especiais dentro de aspas duplas (\ " ` $). Assim o comando pode
 * ser colado direto no terminal mesmo com espaços no account-name.
 */
function shq(value: string): string {
  return `"${value.replace(/([\\"`$])/g, "\\$1")}"`;
}

interface MLConnectScriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** id do admin/usuário-alvo (vai no --user-id). Não é digitado à mão. */
  userId: string;
  /** rótulo do alvo (nome/e-mail) só para exibição no cabeçalho. */
  userLabel?: string;
}

/**
 * Entrega D — Gera (NÃO executa) o comando de conexão de conta ML para o
 * Superadmin colar no terminal. Só constrói a string no cliente; não chama
 * nenhuma rota nem persiste o segredo.
 */
export function MLConnectScriptDialog({
  open,
  onOpenChange,
  userId,
  userLabel,
}: MLConnectScriptDialogProps) {
  const [accountName, setAccountName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(DEFAULT_REDIRECT_URI);
  const [copied, setCopied] = useState(false);

  const command = useMemo(() => {
    const parts = [
      "npx tsx scripts/connect-ml-account.ts",
      `--user-id=${shq(userId)}`,
      `--account-name=${shq(accountName || "<NOME>")}`,
      `--app-client-id=${shq(clientId || "<CLIENT_ID>")}`,
      `--app-client-secret=${shq(clientSecret || "<CLIENT_SECRET>")}`,
      `--redirect-uri=${shq(redirectUri || DEFAULT_REDIRECT_URI)}`,
    ];
    return parts.join(" ");
  }, [userId, accountName, clientId, clientSecret, redirectUri]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard indisponível (contexto inseguro) — ignora */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Gerar script de conexão ML</DialogTitle>
          <DialogDescription>
            Monta o comando para conectar uma conta do Mercado Livre ao usuário
            {userLabel ? ` ${userLabel}` : ""}. O comando não é executado aqui —
            copie e rode no terminal.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ml-account-name">Nome da conta (account-name)</Label>
            <Input
              id="ml-account-name"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="Ex.: Loja Principal"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ml-client-id">App Client ID</Label>
            <Input
              id="ml-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="app-client-id"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ml-client-secret">App Client Secret</Label>
            <Input
              id="ml-client-secret"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="app-client-secret"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ml-redirect-uri">Redirect URI</Label>
            <Input
              id="ml-redirect-uri"
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
            />
          </div>

          <div className="flex items-start gap-2 rounded-md bg-yellow-100 p-2 text-xs text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Segredo sensível — não será salvo. O comando é gerado apenas no seu
              navegador.
            </span>
          </div>

          <div className="space-y-1.5">
            <Label>Comando</Label>
            <pre className="max-h-40 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap break-all">
              {command}
            </pre>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
          <Button onClick={handleCopy}>
            {copied ? (
              <>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Copiado
              </>
            ) : (
              <>
                <Copy className="mr-2 h-4 w-4" />
                Copiar comando
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
