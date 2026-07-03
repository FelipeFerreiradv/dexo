"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

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
import { authHeaders, getApiBaseUrl } from "@/lib/api";

export type CollaboratorLite = {
  id: string;
  name?: string | null;
  email: string;
};

// Sessão compatível com authHeaders (email legado + apiToken). Aceita o objeto
// bruto de useSession sem precisar de cast no chamador.
type SessionLike =
  | { user?: { email?: string | null } | null; apiToken?: string }
  | null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CollaboratorFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  session: SessionLike;
  collaborator?: CollaboratorLite | null;
  /** Chamado após criar/editar com sucesso (mensagem pronta p/ toast). */
  onSuccess: (message: string) => void;
}

/**
 * Modal reutilizável para CRIAR e EDITAR colaboradores do admin logado.
 * - Criação: POST /me/team/collaborators (nome, e-mail, senha).
 * - Edição: PATCH /me/team/collaborators/:id (nome; senha em branco = não altera;
 *   e-mail é imutável por aqui).
 * O vínculo parentUserId é forçado no servidor — nunca enviado pelo cliente.
 */
export function CollaboratorFormDialog({
  open,
  onOpenChange,
  mode,
  session,
  collaborator,
  onSuccess,
}: CollaboratorFormDialogProps) {
  const isEdit = mode === "edit";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Repopula os campos toda vez que o modal abre (ou muda de alvo/modo).
  useEffect(() => {
    if (!open) return;
    setName(collaborator?.name ?? "");
    setEmail(collaborator?.email ?? "");
    setPassword("");
    setConfirmPassword("");
    setShowPassword(false);
    setShowConfirm(false);
    setError(null);
    setSubmitting(false);
  }, [open, mode, collaborator]);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  // Na edição, senha vazia = manter a atual. Na criação é obrigatória.
  const passwordProvided = password.length > 0;
  const passwordNeeded = !isEdit || passwordProvided;

  const nameValid = trimmedName.length > 0;
  const emailValid = isEdit || EMAIL_RE.test(trimmedEmail);
  const passwordValid = !passwordNeeded || password.length >= 8;
  const confirmValid = !passwordNeeded || password === confirmPassword;

  const canSubmit =
    !submitting && nameValid && emailValid && passwordValid && confirmValid;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const apiBase = getApiBaseUrl();
      const headers = authHeaders(session, {
        "Content-Type": "application/json",
      });

      let res: Response;
      if (isEdit && collaborator) {
        const body: { name: string; password?: string } = { name: trimmedName };
        if (passwordProvided) body.password = password;
        res = await fetch(
          `${apiBase}/me/team/collaborators/${collaborator.id}`,
          { method: "PATCH", headers, body: JSON.stringify(body) },
        );
      } else {
        res = await fetch(`${apiBase}/me/team/collaborators`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: trimmedName,
            email: trimmedEmail,
            password,
          }),
        });
      }

      if (!res.ok) {
        let message = "Não foi possível salvar. Tente novamente.";
        try {
          const data = await res.json();
          if (data?.message) message = data.message;
        } catch {
          // resposta sem corpo JSON — mantém a mensagem genérica.
        }
        setError(message);
        return;
      }

      onOpenChange(false);
      onSuccess(
        isEdit
          ? "Colaborador atualizado com sucesso."
          : "Colaborador criado com sucesso.",
      );
    } catch {
      setError("Erro de conexão. Verifique sua internet e tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Editar colaborador" : "Novo colaborador"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Atualize o nome. Deixe a senha em branco para mantê-la."
              : "O colaborador terá acesso aos dados da sua conta com as permissões padrão."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="collab-name">Nome</Label>
            <Input
              id="collab-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nome do colaborador"
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="collab-email">E-mail</Label>
            <Input
              id="collab-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@exemplo.com"
              disabled={isEdit}
              autoComplete="off"
            />
            {isEdit && (
              <p className="text-xs text-muted-foreground">
                O e-mail de acesso não pode ser alterado.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="collab-password">
              {isEdit ? "Nova senha (opcional)" : "Senha"}
            </Label>
            <div className="relative">
              <Input
                id="collab-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  isEdit ? "Deixe em branco para manter" : "Mínimo 8 caracteres"
                }
                autoComplete="new-password"
                className="pr-12"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                aria-pressed={showPassword}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden />
                )}
              </button>
            </div>
          </div>

          {passwordNeeded && (
            <div className="space-y-2">
              <Label htmlFor="collab-confirm">Confirmar senha</Label>
              <div className="relative">
                <Input
                  id="collab-confirm"
                  type={showConfirm ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repita a senha"
                  autoComplete="new-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((prev) => !prev)}
                  aria-label={showConfirm ? "Ocultar senha" : "Mostrar senha"}
                  aria-pressed={showConfirm}
                  className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {showConfirm ? (
                    <EyeOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>
              {passwordProvided && !confirmValid && (
                <p className="text-xs text-destructive">
                  As senhas não coincidem.
                </p>
              )}
              {passwordProvided && !passwordValid && (
                <p className="text-xs text-destructive">
                  A senha deve ter no mínimo 8 caracteres.
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting
                ? "Salvando..."
                : isEdit
                  ? "Salvar"
                  : "Criar colaborador"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
