"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Mail, User, Hash, ShieldCheck, PenSquare, Copy } from "lucide-react";
import { Session } from "next-auth";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { getApiBaseUrl } from "@/lib/api";

type ProfileData = {
  id?: string;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  role?: string | null;
  createdAt?: string;
};

interface ProfileModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  onRequestEdit?: () => void;
}

export function ProfileModal({
  open,
  onOpenChange,
  session,
  onRequestEdit,
}: ProfileModalProps) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(false);

  const apiBase = useMemo(() => getApiBaseUrl(), []);

  const fallbackProfile: ProfileData = useMemo(
    () => ({
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      avatarUrl: (session.user as any).image ?? null,
    }),
    [
      session.user?.email,
      session.user?.id,
      session.user?.name,
      (session.user as any)?.image,
    ],
  );

  useEffect(() => {
    if (!open || !session?.user?.email) return;
    let active = true;
    const load = async () => {
      try {
        setLoading(true);
        const resp = await fetch(`${apiBase}/users/me`, {
          headers: { email: session.user.email },
        });
        if (!resp.ok) throw new Error("Falha ao carregar perfil");
        const data = await resp.json();
        if (active) {
          setProfile({
            id: data.id,
            name: data.name,
            email: data.email,
            avatarUrl: data.avatarUrl ?? null,
            role: data.role,
            createdAt: data.createdAt,
          });
        }
      } catch (error) {
        console.error(error);
        if (active) setProfile(fallbackProfile);
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [apiBase, open, session?.user?.email, fallbackProfile]);

  const current = profile ?? fallbackProfile;

  const copyId = () => {
    if (current?.id) {
      navigator.clipboard?.writeText(current.id).catch(() => undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full md:max-w-4xl lg:max-w-5xl overflow-hidden border border-border/60 bg-card/90 p-0 backdrop-blur">
        <div className="grid min-h-[340px] w-full grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
          <div className="relative flex flex-col items-center justify-center gap-5 bg-gradient-to-br from-primary/18 via-primary/8 to-background px-8 py-10 text-center">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_32%_22%,theme(colors.primary/26),transparent_40%),radial-gradient(circle_at_78%_18%,theme(colors.primary/16),transparent_36%),radial-gradient(circle_at_55%_78%,theme(colors.primary/18),transparent_40%)]"
            />
            <div className="relative">
              <Avatar className="size-24 border-4 border-background/70 shadow-xl shadow-primary/25">
                <AvatarImage
                  src={current.avatarUrl || "/avatar.png"}
                  alt={current.name ?? "Usuário"}
                />
                <AvatarFallback className="bg-primary text-lg font-semibold text-primary-foreground">
                  {current?.name?.slice(0, 2)?.toUpperCase() ||
                    session.user?.email?.slice(0, 2)?.toUpperCase() ||
                    "US"}
                </AvatarFallback>
              </Avatar>
            </div>

            <div className="relative space-y-1">
              <p className="text-xl font-semibold text-foreground">
                {current?.name || "Usuário"}
              </p>
              <p className="text-sm text-muted-foreground">
                {current?.email || "—"}
              </p>
            </div>

            <div className="relative flex flex-wrap items-center justify-center gap-2 text-xs uppercase tracking-[0.08em]">
              <span className="rounded-full border border-border/60 bg-background/60 px-3 py-1 text-muted-foreground shadow-sm">
                <ShieldCheck className="mr-1 inline size-3" />
                {current?.role || "USER"}
              </span>
              {current?.id ? (
                <button
                  type="button"
                  onClick={copyId}
                  className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 font-semibold text-primary transition hover:border-primary/60 hover:text-primary"
                >
                  <Hash className="size-3" />
                  {current.id.slice(0, 6)}…{current.id.slice(-4)}
                  <Copy className="size-3" />
                </button>
              ) : null}
            </div>

            {onRequestEdit ? (
              <Button
                variant="secondary"
                size="sm"
                className="relative rounded-full border border-border/80 bg-background/80 shadow-md"
                onClick={() => {
                  onOpenChange(false);
                  onRequestEdit();
                }}
              >
                <PenSquare className="mr-2 size-4" />
                Editar perfil
              </Button>
            ) : null}
          </div>

          <div className="flex flex-col gap-4 p-6 min-w-0">
            <DialogHeader className="space-y-1 text-left">
              <DialogTitle className="text-xl font-bold">
                Detalhes do perfil
              </DialogTitle>
              <p className="text-sm text-muted-foreground">
                Visualize rapidamente os dados da sua conta.
              </p>
            </DialogHeader>

            <div className="grid gap-3 rounded-xl border border-border/60 bg-muted/20 p-4 shadow-inner shadow-black/5">
              {loading ? (
                <div className="space-y-3">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-60" />
                  <Skeleton className="h-4 w-52" />
                </div>
              ) : (
                <>
                  <InfoRow
                    icon={<User className="size-4" />}
                    label="Nome de usuário"
                    value={current?.name || "—"}
                  />
                  <InfoRow
                    icon={<Mail className="size-4" />}
                    label="Email"
                    value={current?.email || "—"}
                  />
                  <InfoRow
                    icon={<Hash className="size-4" />}
                    label="ID do cliente"
                    value={current?.id || "—"}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-sm shadow-sm">
      <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <div className="flex flex-col">
        <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </span>
        <span className="font-semibold text-foreground">{value}</span>
      </div>
    </div>
  );
}
