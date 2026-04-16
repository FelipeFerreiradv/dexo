"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { getApiBaseUrl } from "@/lib/api";

interface NfeCancelDialogProps {
  nfeId: string | null;
  nfeNumero: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancelled: () => void;
}

export function NfeCancelDialog({
  nfeId,
  nfeNumero,
  open,
  onOpenChange,
  onCancelled,
}: NfeCancelDialogProps) {
  const { data: session } = useSession();
  const [justificativa, setJustificativa] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = justificativa.trim().length >= 15;

  const handleCancel = async () => {
    if (!nfeId || !session?.user?.email || !canSubmit) return;

    setLoading(true);
    setError(null);

    try {
      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/fiscal/nfe/${nfeId}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
        body: JSON.stringify({ justificativa: justificativa.trim() }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setError(data.error || data.mensagem || "Erro ao cancelar NF-e");
        return;
      }

      setJustificativa("");
      onOpenChange(false);
      onCancelled();
    } catch (err) {
      setError("Erro de conexao ao cancelar NF-e");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-destructive" />
            Cancelar NF-e {nfeNumero ? `#${nfeNumero}` : ""}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Esta acao e irreversivel. A NF-e sera cancelada junto a SEFAZ. Voce
            precisa informar uma justificativa com no minimo 15 caracteres.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 py-2">
          <Textarea
            placeholder="Justificativa do cancelamento (minimo 15 caracteres)..."
            value={justificativa}
            onChange={(e) => setJustificativa(e.target.value)}
            rows={3}
            className="resize-none"
          />
          <div className="text-xs text-muted-foreground text-right">
            {justificativa.trim().length}/15 caracteres
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={loading}
            onClick={() => {
              setJustificativa("");
              setError(null);
            }}
          >
            Voltar
          </AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleCancel}
            disabled={!canSubmit || loading}
          >
            {loading ? "Cancelando..." : "Confirmar Cancelamento"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
