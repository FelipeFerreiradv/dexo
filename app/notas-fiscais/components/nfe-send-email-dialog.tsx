"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getApiBaseUrl } from "@/lib/api";

interface NfeSendEmailDialogProps {
  nfeId: string | null;
  nfeNumero: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}

export function NfeSendEmailDialog({
  nfeId,
  nfeNumero,
  open,
  onOpenChange,
  onSent,
}: NfeSendEmailDialogProps) {
  const { data: session } = useSession();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const canSubmit = email.trim().length > 0 && email.includes("@");

  const handleSend = async () => {
    if (!nfeId || !session?.user?.email || !canSubmit) return;

    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const apiBase = getApiBaseUrl();
      const response = await fetch(
        `${apiBase}/fiscal/nfe/${nfeId}/resend-email`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            email: session.user.email,
          },
          body: JSON.stringify({ email: email.trim() }),
        },
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        setError(data.error || "Erro ao enviar e-mail");
        return;
      }

      setSuccess(true);
      onSent();
      setTimeout(() => {
        setEmail("");
        setSuccess(false);
        onOpenChange(false);
      }, 1500);
    } catch {
      setError("Erro de conexao ao enviar e-mail");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setEmail("");
          setError(null);
          setSuccess(false);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="size-5" />
            Enviar NF-e {nfeNumero ? `#${nfeNumero}` : ""} por e-mail
          </DialogTitle>
          <DialogDescription>
            O XML e DANFE serao enviados como anexo para o e-mail informado.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-2">
            <Label htmlFor="send-email">E-mail do destinatario</Label>
            <Input
              id="send-email"
              type="email"
              placeholder="destinatario@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) handleSend();
              }}
            />
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-md border border-green-500/40 bg-green-500/5 p-2 text-sm text-green-600">
              E-mail enviado com sucesso!
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancelar
          </Button>
          <Button onClick={handleSend} disabled={!canSubmit || loading}>
            {loading ? "Enviando..." : "Enviar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
