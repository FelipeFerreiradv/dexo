"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  User,
  Settings,
  Server,
  Link,
  ShieldCheck,
  Puzzle,
  CreditCard,
} from "lucide-react";

interface ConfigModalProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export default function ConfigModal({ open, onOpenChange }: ConfigModalProps) {
  const { data: session } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const [defaultDescription, setDefaultDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // sync controlled open
  useEffect(() => {
    if (typeof open === "boolean") setIsOpen(open);
  }, [open]);

  useEffect(() => {
    if (!isOpen) return;
    fetchUserSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const fetchUserSettings = async () => {
    setLoading(true);
    try {
      // Preferir /users/:id quando id interno estiver disponível
      if (session?.user?.id) {
        const response = await fetch(
          `http://localhost:3333/users/${session.user.id}`,
        );
        if (response.ok) {
          const user = await response.json();
          setDefaultDescription(user.defaultProductDescription || "");
          setLoading(false);
          return;
        }
      }

      // Fallback: usar /users/me com header email
      if (session?.user?.email) {
        const resp = await fetch(`http://localhost:3333/users/me`, {
          headers: { email: session.user.email },
        });
        if (resp.ok) {
          const user = await resp.json();
          setDefaultDescription(user.defaultProductDescription || "");
          setLoading(false);
          return;
        }
      }

      alert("Erro ao carregar configurações");
    } catch (error) {
      alert("Erro de conexão");
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Preferir /users/:id quando id interno estiver disponível
      if (session?.user?.id) {
        const response = await fetch(
          `http://localhost:3333/users/${session.user.id}/settings`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              defaultProductDescription: defaultDescription,
            }),
          },
        );

        if (response.ok) {
          alert("Configurações salvas com sucesso!");
          onOpenChange?.(false);
          setSaving(false);
          return;
        }
      }

      // Fallback: PUT /users/me/settings com header email
      if (session?.user?.email) {
        const resp = await fetch(`http://localhost:3333/users/me/settings`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            email: session.user.email,
          },
          body: JSON.stringify({
            defaultProductDescription: defaultDescription,
          }),
        });
        if (resp.ok) {
          alert("Configurações salvas com sucesso!");
          onOpenChange?.(false);
          setSaving(false);
          return;
        }
      }

      alert("Erro ao salvar configurações");
    } catch (error) {
      alert("Erro de conexão");
    } finally {
      setSaving(false);
    }
  };

  const handleOpenChange = (val: boolean) => {
    setIsOpen(val);
    onOpenChange?.(val);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {/* optional trigger could be used by parent */}
      <DialogContent className="w-full max-w-3xl sm:max-w-4xl max-h-[80vh] overflow-auto p-6 sm:p-8">
        <DialogHeader>
          <DialogTitle className="font-bold">Configurações</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6 min-h-[200px]">
          {/* Stack on small screens, two columns from md up */}
          <aside className="border-r pr-4 md:pr-6">
            {/* Sidebar uses fixed width on md+, full width on small screens */}
            <ul className="space-y-2">
              <li className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <User className="size-4" /> Conta
              </li>
              <li className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Settings className="size-4" /> Preferências
              </li>
            </ul>
          </aside>

          <main className="min-w-0">
            {loading ? (
              <div>Carregando...</div>
            ) : (
              <div>
                <div className="mb-4">
                  <h3 className="text-sm font-bold">
                    Descrição Padrão de Produto
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Esta descrição será aplicada automaticamente quando você
                    criar um produto sem especificar uma descrição.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="cfgDefaultDescription" className="font-bold">
                    Descrição Padrão
                  </Label>
                  <Textarea
                    id="cfgDefaultDescription"
                    value={defaultDescription}
                    onChange={(e) => setDefaultDescription(e.target.value)}
                    rows={6}
                  />
                </div>

                <div className="mt-6 flex gap-2">
                  <Button onClick={handleSave} disabled={saving}>
                    {saving ? "Salvando..." : "Salvar"}
                  </Button>
                  <Button variant="ghost" onClick={fetchUserSettings}>
                    Recarregar
                  </Button>
                </div>
              </div>
            )}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
