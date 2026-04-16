"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  Ban,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getApiBaseUrl } from "@/lib/api";

interface InutilizacaoItem {
  id: string;
  ambiente: string;
  serie: number;
  numeroInicial: number;
  numeroFinal: number;
  justificativa: string;
  protocolo: string | null;
  status: string;
  createdAt: string;
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "error";
}

const FISCAL_MODULE_ENABLED =
  process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED === "true";

export default function InutilizarNumeroPage() {
  const { data: session, status: authStatus } = useSession();
  const router = useRouter();

  const [serie, setSerie] = useState("1");
  const [numeroInicial, setNumeroInicial] = useState("");
  const [numeroFinal, setNumeroFinal] = useState("");
  const [justificativa, setJustificativa] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [items, setItems] = useState<InutilizacaoItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    },
    [],
  );

  const canSubmit =
    Number(serie) >= 1 &&
    Number(numeroInicial) >= 1 &&
    Number(numeroFinal) >= 1 &&
    Number(numeroInicial) <= Number(numeroFinal) &&
    justificativa.trim().length >= 15;

  const fetchItems = useCallback(async () => {
    if (!session?.user?.email) return;
    try {
      setItemsLoading(true);
      const response = await fetch(`${getApiBaseUrl()}/fiscal/inutilizacao`, {
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
      });
      if (!response.ok) throw new Error("Erro ao buscar historico");
      const data = await response.json();
      setItems(data.items ?? []);
    } catch {
      console.error("Erro ao buscar historico de inutilizacoes");
    } finally {
      setItemsLoading(false);
    }
  }, [session?.user?.email]);

  useEffect(() => {
    if (authStatus === "authenticated") {
      fetchItems();
    }
  }, [authStatus, fetchItems]);

  if (!FISCAL_MODULE_ENABLED) {
    router.push("/");
    return null;
  }

  if (authStatus === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const handleSubmit = async () => {
    if (!session?.user?.email || !canSubmit) return;

    setLoading(true);

    try {
      const response = await fetch(`${getApiBaseUrl()}/fiscal/inutilizacao`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
        body: JSON.stringify({
          serie: Number(serie),
          numeroInicial: Number(numeroInicial),
          numeroFinal: Number(numeroFinal),
          justificativa: justificativa.trim(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        showToast(data.error || "Erro ao inutilizar", "error");
        return;
      }

      if (data.success) {
        showToast("Inutilizacao aceita pela SEFAZ", "success");
        setNumeroInicial("");
        setNumeroFinal("");
        setJustificativa("");
        fetchItems();
      } else {
        showToast(data.mensagem || "Inutilizacao rejeitada", "error");
        fetchItems();
      }
    } catch {
      showToast("Erro de conexao", "error");
    } finally {
      setLoading(false);
      setConfirmOpen(false);
    }
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case "ACEITA":
        return (
          <Badge className="bg-green-500/10 text-green-600 border-green-500/30">
            <CheckCircle2 className="size-3 mr-1" />
            Aceita
          </Badge>
        );
      case "REJEITADA":
        return (
          <Badge className="bg-red-500/10 text-red-600 border-red-500/30">
            <XCircle className="size-3 mr-1" />
            Rejeitada
          </Badge>
        );
      default:
        return (
          <Badge className="bg-yellow-500/10 text-yellow-600 border-yellow-500/30">
            <Clock className="size-3 mr-1" />
            Pendente
          </Badge>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          Notas Fiscais
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          Inutilizar Numeracao
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Inutilize faixas de numeracao de NF-e que nao serao utilizadas
        </p>
      </div>

      {/* Form */}
      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader>
          <CardTitle>Nova Inutilizacao</CardTitle>
          <CardDescription>
            Informe a serie, faixa de numeros e justificativa para inutilizar
            junto a SEFAZ.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="serie">Serie</Label>
              <Input
                id="serie"
                type="number"
                min={1}
                value={serie}
                onChange={(e) => setSerie(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="numero-inicial">Numero Inicial</Label>
              <Input
                id="numero-inicial"
                type="number"
                min={1}
                placeholder="Ex: 1"
                value={numeroInicial}
                onChange={(e) => setNumeroInicial(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="numero-final">Numero Final</Label>
              <Input
                id="numero-final"
                type="number"
                min={1}
                placeholder="Ex: 5"
                value={numeroFinal}
                onChange={(e) => setNumeroFinal(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <Label htmlFor="justificativa">
              Justificativa (minimo 15 caracteres)
            </Label>
            <Textarea
              id="justificativa"
              rows={3}
              placeholder="Informe o motivo da inutilizacao..."
              value={justificativa}
              onChange={(e) => setJustificativa(e.target.value)}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground text-right">
              {justificativa.trim().length}/15 caracteres
            </p>
          </div>

          <div className="mt-4 flex justify-end">
            <Button
              disabled={!canSubmit || loading}
              onClick={() => setConfirmOpen(true)}
            >
              <Ban className="size-4 mr-1" />
              Inutilizar Numeracao
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* History */}
      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader>
          <CardTitle>Historico de Inutilizacoes</CardTitle>
          <CardDescription>
            Inutilizacoes realizadas neste ambiente
          </CardDescription>
        </CardHeader>
        <CardContent>
          {itemsLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div
                  key={i}
                  className="h-12 bg-muted/30 rounded animate-pulse"
                />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Ban className="size-12 text-muted-foreground/40 mb-4" />
              <p className="text-muted-foreground">
                Nenhuma inutilizacao registrada
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Serie</TableHead>
                  <TableHead>Faixa</TableHead>
                  <TableHead>Justificativa</TableHead>
                  <TableHead>Protocolo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Data</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-sm">
                      {item.serie}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {item.numeroInicial} — {item.numeroFinal}
                    </TableCell>
                    <TableCell className="text-sm max-w-[200px] truncate">
                      {item.justificativa}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {item.protocolo ?? "—"}
                    </TableCell>
                    <TableCell>{statusBadge(item.status)}</TableCell>
                    <TableCell className="text-sm">
                      {new Date(item.createdAt).toLocaleDateString("pt-BR")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-500" />
              Confirmar Inutilizacao
            </AlertDialogTitle>
            <AlertDialogDescription>
              Voce esta prestes a inutilizar a faixa de numeros{" "}
              <strong>
                {numeroInicial} a {numeroFinal}
              </strong>{" "}
              da serie <strong>{serie}</strong>. Esta acao e irreversivel e sera
              registrada junto a SEFAZ.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Voltar</AlertDialogCancel>
            <Button onClick={handleSubmit} disabled={loading}>
              {loading ? "Processando..." : "Confirmar Inutilizacao"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Toasts */}
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`fixed bottom-4 right-4 p-4 rounded-md shadow-lg z-50 ${
            toast.type === "success" ? "bg-green-500" : "bg-red-500"
          } text-white`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
