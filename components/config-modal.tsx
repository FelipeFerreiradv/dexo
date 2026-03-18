"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSession } from "next-auth/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { getApiBaseUrl } from "@/lib/api";
import { ImageUpload } from "@/components/ui/image-upload";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BadgeCheck,
  User,
  Settings,
  RefreshCw,
  Lock,
  Image as ImageIcon,
} from "lucide-react";

interface ConfigModalProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onUserUpdated?: () => void;
}

export default function ConfigModal({
  open,
  onOpenChange,
  onUserUpdated,
}: ConfigModalProps) {
  const { data: session } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"conta" | "preferencias">("conta");
  const [loading, setLoading] = useState(true);
  const [savingAccount, setSavingAccount] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [defaultDescription, setDefaultDescription] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const apiBase = useMemo(() => getApiBaseUrl(), []);

  // sync controlled open
  useEffect(() => {
    if (typeof open === "boolean") setIsOpen(open);
  }, [open]);

  const fetchUserSettings = useCallback(async () => {
    if (!session?.user?.email) return;
    setLoading(true);
    try {
      const resp = await fetch(`${apiBase}/users/me`, {
        headers: { email: session.user.email },
      });
      if (!resp.ok) throw new Error("Erro ao carregar configurações");
      const user = await resp.json();
      setUsername(user.name ?? "");
      setEmail(user.email ?? "");
      setAvatarUrl(user.avatarUrl ?? "");
      setDefaultDescription(user.defaultProductDescription ?? "");
    } catch (error) {
      alert("Erro ao carregar configurações");
    } finally {
      setLoading(false);
    }
  }, [apiBase, session?.user?.email]);

  useEffect(() => {
    if (!isOpen) return;
    fetchUserSettings();
  }, [fetchUserSettings, isOpen]);

  const handleSaveAccount = async () => {
    if (!session?.user?.email) return;
    if (newPassword && newPassword !== confirmPassword) {
      alert("As senhas não coincidem.");
      return;
    }

    setSavingAccount(true);
    try {
      const resp = await fetch(`${apiBase}/users/me/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
        body: JSON.stringify({
          name: username,
          avatarUrl: avatarUrl || null,
          password: newPassword || undefined,
        }),
      });

      if (!resp.ok) throw new Error("Erro ao salvar dados da conta");

      alert("Conta atualizada com sucesso!");
      setNewPassword("");
      setConfirmPassword("");
      onUserUpdated?.();
    } catch (error) {
      alert("Erro ao salvar conta");
    } finally {
      setSavingAccount(false);
    }
  };

  const handleSavePreferences = async () => {
    if (!session?.user?.email) return;
    setSavingPrefs(true);
    try {
      const resp = await fetch(`${apiBase}/users/me/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
        body: JSON.stringify({
          defaultProductDescription: defaultDescription,
        }),
      });

      if (!resp.ok) throw new Error("Erro ao salvar preferências");

      alert("Preferências salvas!");
    } catch (error) {
      alert("Erro ao salvar preferências");
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleOpenChange = (val: boolean) => {
    setIsOpen(val);
    onOpenChange?.(val);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="w-full max-w-5xl md:max-w-6xl max-h-[85vh] overflow-auto border border-border/70 bg-card/70 p-0 backdrop-blur">
        <div className="flex items-start justify-between border-b border-border/60 px-6 py-5">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-xl font-bold">
              Configurações
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              Ajuste os dados da sua conta e preferências rápidas.
            </p>
          </DialogHeader>
          {/* <Button
            variant="ghost"
            size="sm"
            onClick={fetchUserSettings}
            className="gap-2 rounded-full border border-border/60 bg-muted/40"
          >
            <RefreshCw className="size-4" />
            Recarregar
          </Button> */}
        </div>

        <div className="grid grid-cols-1 items-start gap-6 p-6 md:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="space-y-2">
            <NavItem
              icon={<User className="size-4" />}
              active={activeTab === "conta"}
              label="Conta"
              onClick={() => setActiveTab("conta")}
            />
            <NavItem
              icon={<Settings className="size-4" />}
              active={activeTab === "preferencias"}
              label="Preferências"
              onClick={() => setActiveTab("preferencias")}
            />
          </aside>

          <main className="min-w-0">
            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-10 w-48" />
              </div>
            ) : activeTab === "conta" ? (
              <AccountSection
                username={username}
                email={email}
                avatarUrl={avatarUrl}
                newPassword={newPassword}
                confirmPassword={confirmPassword}
                onUsernameChange={setUsername}
                onAvatarChange={setAvatarUrl}
                onNewPasswordChange={setNewPassword}
                onConfirmPasswordChange={setConfirmPassword}
                onSave={handleSaveAccount}
                saving={savingAccount}
              />
            ) : (
              <PreferencesSection
                defaultDescription={defaultDescription}
                onDescriptionChange={setDefaultDescription}
                onSave={handleSavePreferences}
                saving={savingPrefs}
              />
            )}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-sm font-medium transition ${
        active
          ? "border-primary/50 bg-primary/10 text-primary shadow-sm"
          : "border-border/70 bg-card/70 text-foreground hover:border-primary/30 hover:text-primary"
      }`}
    >
      <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function AccountSection(props: {
  username: string;
  email: string;
  avatarUrl: string;
  newPassword: string;
  confirmPassword: string;
  onUsernameChange: (value: string) => void;
  onAvatarChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const {
    username,
    email,
    avatarUrl,
    newPassword,
    confirmPassword,
    onUsernameChange,
    onAvatarChange,
    onNewPasswordChange,
    onConfirmPasswordChange,
    onSave,
    saving,
  } = props;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border/60 bg-muted/20 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Dados da conta</h3>
            <p className="text-sm text-muted-foreground">
              Atualize nome de usuário, email e foto de perfil.
            </p>
          </div>
          <BadgeCheck className="size-5 text-primary" />
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="username">Nome de usuário</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              placeholder="Seu nome de exibição"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={email} disabled className="opacity-80" />
          </div>
        </div>

        <Separator className="my-6" />

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_minmax(320px,0.9fr)]">
          <div className="space-y-3">
            <Label className="flex items-center gap-2">
              <ImageIcon className="size-4" />
              Foto de perfil
            </Label>
            <ImageUpload
              value={avatarUrl}
              onChange={onAvatarChange}
              onError={(err) => alert(err)}
              className="w-full"
            />
          </div>

          <div className="space-y-3 rounded-xl border border-border/60 bg-card/60 p-4 shadow-sm">
            <div className="space-y-1">
              <Label className="flex items-center gap-2">
                <Lock className="size-4" />
                Senha
              </Label>
              <p className="text-xs text-muted-foreground">
                Deixe em branco para manter a senha atual.
              </p>
            </div>
            <div className="space-y-2">
              <Input
                type="password"
                placeholder="Nova senha"
                value={newPassword}
                onChange={(e) => onNewPasswordChange(e.target.value)}
              />
              <Input
                type="password"
                placeholder="Confirmar nova senha"
                value={confirmPassword}
                onChange={(e) => onConfirmPasswordChange(e.target.value)}
              />
            </div>
            <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Use uma senha forte com pelo menos 8 caracteres.
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={onSave} disabled={saving}>
            {saving ? "Salvando..." : "Salvar alterações"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function PreferencesSection(props: {
  defaultDescription: string;
  onDescriptionChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { defaultDescription, onDescriptionChange, onSave, saving } = props;
  return (
    <section className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-5 shadow-sm">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Preferências</h3>
        <p className="text-sm text-muted-foreground">
          Defina a descrição padrão usada ao criar novos produtos.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="cfgDefaultDescription" className="font-bold">
          Descrição padrão
        </Label>
        <Textarea
          id="cfgDefaultDescription"
          value={defaultDescription}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={6}
        />
        <p className="text-xs text-muted-foreground">
          Esta descrição será aplicada automaticamente quando você criar um
          produto sem especificar uma descrição.
        </p>
      </div>

      <div className="flex gap-2">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Salvando..." : "Salvar"}
        </Button>
      </div>
    </section>
  );
}
