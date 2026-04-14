"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSession } from "next-auth/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getApiBaseUrl } from "@/lib/api";
import { ImageUpload } from "@/components/ui/image-upload";
import { Skeleton } from "@/components/ui/skeleton";
import { User, Settings } from "lucide-react";

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
  const [defaultCostPrice, setDefaultCostPrice] = useState<string>("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Padrões de anúncio ML
  const [defaultListingType, setDefaultListingType] = useState("bronze");
  const [defaultHasWarranty, setDefaultHasWarranty] = useState(false);
  const [defaultWarrantyUnit, setDefaultWarrantyUnit] = useState("dias");
  const [defaultWarrantyDuration, setDefaultWarrantyDuration] =
    useState<string>("30");
  const [defaultItemCondition, setDefaultItemCondition] = useState("new");
  const [defaultShippingMode, setDefaultShippingMode] = useState("me2");
  const [defaultFreeShipping, setDefaultFreeShipping] = useState(false);
  const [defaultLocalPickup, setDefaultLocalPickup] = useState(false);
  const [defaultManufacturingTime, setDefaultManufacturingTime] =
    useState<string>("0");

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
      setDefaultCostPrice(
        user.defaultCostPrice != null ? String(user.defaultCostPrice) : "",
      );

      // Padrões de anúncio ML
      setDefaultListingType(user.defaultListingType ?? "bronze");
      setDefaultHasWarranty(user.defaultHasWarranty ?? false);
      setDefaultWarrantyUnit(user.defaultWarrantyUnit ?? "dias");
      setDefaultWarrantyDuration(
        user.defaultWarrantyDuration != null
          ? String(user.defaultWarrantyDuration)
          : "30",
      );
      setDefaultItemCondition(user.defaultItemCondition ?? "new");
      setDefaultShippingMode(user.defaultShippingMode ?? "me2");
      setDefaultFreeShipping(user.defaultFreeShipping ?? false);
      setDefaultLocalPickup(user.defaultLocalPickup ?? false);
      setDefaultManufacturingTime(
        user.defaultManufacturingTime != null
          ? String(user.defaultManufacturingTime)
          : "0",
      );
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
          defaultCostPrice: defaultCostPrice ? Number(defaultCostPrice) : null,

          // Padrões de anúncio ML
          defaultListingType: defaultListingType || "bronze",
          defaultHasWarranty: defaultHasWarranty,
          defaultWarrantyUnit: defaultWarrantyUnit || "dias",
          defaultWarrantyDuration: defaultWarrantyDuration
            ? Number(defaultWarrantyDuration)
            : null,
          defaultItemCondition: defaultItemCondition || "new",
          defaultShippingMode: defaultShippingMode || "me2",
          defaultFreeShipping: defaultFreeShipping,
          defaultLocalPickup: defaultLocalPickup,
          defaultManufacturingTime: defaultManufacturingTime
            ? Number(defaultManufacturingTime)
            : 0,
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
      <DialogContent className="w-full max-w-6xl md:max-w-7xl h-[88vh] max-h-[88vh] overflow-hidden border border-border/80 bg-card/95 p-0 shadow-2xl">
        <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="bg-sidebar text-sidebar-foreground hidden h-full min-h-0 flex-col border-r border-sidebar-border/60 md:flex">
            <div className="border-b border-sidebar-border/60 px-5 py-4">
              <p className="text-xs uppercase tracking-[0.14em] text-sidebar-foreground/60">
                Navegação
              </p>
              <p className="text-lg font-semibold text-sidebar-foreground">
                Configurações
              </p>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-3">
              <NavItem
                icon={<User className="size-4" />}
                active={activeTab === "conta"}
                label="Conta"
                description="Identidade, acesso e avatar"
                onClick={() => setActiveTab("conta")}
              />
              <NavItem
                icon={<Settings className="size-4" />}
                active={activeTab === "preferencias"}
                label="Preferências"
                description="Padrões de produto e anúncio"
                onClick={() => setActiveTab("preferencias")}
              />
            </nav>
            <div className="border-t border-sidebar-border/60 px-4 py-3 text-xs text-sidebar-foreground/70">
              <p className="font-semibold text-sidebar-foreground">Atalhos</p>
              <p>Ctrl/Cmd + B para recolher.</p>
            </div>
          </aside>

          <main className="flex h-full min-h-0 flex-col bg-card">
            <div className="border-b border-border/70 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <DialogHeader className="space-y-1 text-left">
                  <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    {activeTab === "conta" ? "Conta" : "Preferências"}
                  </p>
                  <DialogTitle className="text-2xl font-semibold leading-tight">
                    {activeTab === "conta"
                      ? "Ajuste sua conta"
                      : "Defina preferências padrão"}
                  </DialogTitle>
                  <p className="text-sm text-muted-foreground">
                    Todas as alterações respeitam tema, acessibilidade e fluxos
                    existentes.
                  </p>
                </DialogHeader>
              </div>
              <div className="mt-3 flex gap-2 md:hidden">
                <NavPill
                  icon={<User className="size-4" />}
                  label="Conta"
                  active={activeTab === "conta"}
                  onClick={() => setActiveTab("conta")}
                />
                <NavPill
                  icon={<Settings className="size-4" />}
                  label="Preferências"
                  active={activeTab === "preferencias"}
                  onClick={() => setActiveTab("preferencias")}
                />
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
              {loading ? (
                <SettingsSkeleton />
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
                  defaultCostPrice={defaultCostPrice}
                  onCostPriceChange={setDefaultCostPrice}
                  defaultListingType={defaultListingType}
                  onListingTypeChange={setDefaultListingType}
                  defaultHasWarranty={defaultHasWarranty}
                  onHasWarrantyChange={setDefaultHasWarranty}
                  defaultWarrantyUnit={defaultWarrantyUnit}
                  onWarrantyUnitChange={setDefaultWarrantyUnit}
                  defaultWarrantyDuration={defaultWarrantyDuration}
                  onWarrantyDurationChange={setDefaultWarrantyDuration}
                  defaultItemCondition={defaultItemCondition}
                  onItemConditionChange={setDefaultItemCondition}
                  defaultShippingMode={defaultShippingMode}
                  onShippingModeChange={setDefaultShippingMode}
                  defaultFreeShipping={defaultFreeShipping}
                  onFreeShippingChange={setDefaultFreeShipping}
                  defaultLocalPickup={defaultLocalPickup}
                  onLocalPickupChange={setDefaultLocalPickup}
                  defaultManufacturingTime={defaultManufacturingTime}
                  onManufacturingTimeChange={setDefaultManufacturingTime}
                  onSave={handleSavePreferences}
                  saving={savingPrefs}
                />
              )}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NavItem({
  icon,
  label,
  description,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
      }`}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-sidebar-accent/20 text-sidebar-foreground">
        {icon}
      </span>
      <span className="flex-1 text-left">
        <span className="block font-medium leading-tight">{label}</span>
        {description ? (
          <span className="text-xs text-sidebar-foreground/70">
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function NavPill({
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
      onClick={onClick}
      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border/60 bg-card/70 text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      <span className="font-medium">{label}</span>
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
    <div className="space-y-5">
      <SettingGroup
        title="Perfil e identidade"
        description="Mantenha seus dados de conta alinhados e seguros."
      >
        <SettingRow
          title="Foto de perfil"
          description="Atualize a imagem exibida em toda a plataforma."
          alignTop
        >
          <ImageUpload
            value={avatarUrl}
            onChange={onAvatarChange}
            onError={(err) => alert(err)}
            className="w-full max-w-[260px]"
          />
        </SettingRow>
        <SettingRow
          title="Nome de usuário"
          description="Esse nome aparece em colaborações e registros."
        >
          <div className="space-y-1">
            <Label htmlFor="username" className="sr-only">
              Nome de usuário
            </Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              placeholder="Seu nome de exibição"
            />
          </div>
        </SettingRow>
        <SettingRow
          title="Email"
          description="Email utilizado para login e integrações."
        >
          <div className="space-y-1">
            <Label htmlFor="email" className="sr-only">
              Email
            </Label>
            <Input
              id="email"
              value={email}
              disabled
              aria-readonly
              className="opacity-80"
            />
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title="Segurança"
        description="Atualize sua senha. Deixe em branco para manter a atual."
      >
        <SettingRow title="Senha" description="Use pelo menos 8 caracteres.">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="new-password" className="sr-only">
                Nova senha
              </Label>
              <Input
                id="new-password"
                type="password"
                placeholder="Nova senha"
                value={newPassword}
                onChange={(e) => onNewPasswordChange(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="confirm-password" className="sr-only">
                Confirmar nova senha
              </Label>
              <Input
                id="confirm-password"
                type="password"
                placeholder="Confirmar nova senha"
                value={confirmPassword}
                onChange={(e) => onConfirmPasswordChange(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Senhas não são salvas se estes campos ficarem vazios.
          </p>
        </SettingRow>
      </SettingGroup>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Salvando..." : "Salvar alterações"}
        </Button>
      </div>
    </div>
  );
}

function PreferencesSection(props: {
  defaultDescription: string;
  onDescriptionChange: (value: string) => void;
  defaultCostPrice: string;
  onCostPriceChange: (value: string) => void;
  defaultListingType: string;
  onListingTypeChange: (value: string) => void;
  defaultHasWarranty: boolean;
  onHasWarrantyChange: (value: boolean) => void;
  defaultWarrantyUnit: string;
  onWarrantyUnitChange: (value: string) => void;
  defaultWarrantyDuration: string;
  onWarrantyDurationChange: (value: string) => void;
  defaultItemCondition: string;
  onItemConditionChange: (value: string) => void;
  defaultShippingMode: string;
  onShippingModeChange: (value: string) => void;
  defaultFreeShipping: boolean;
  onFreeShippingChange: (value: boolean) => void;
  defaultLocalPickup: boolean;
  onLocalPickupChange: (value: boolean) => void;
  defaultManufacturingTime: string;
  onManufacturingTimeChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const {
    defaultDescription,
    onDescriptionChange,
    defaultCostPrice,
    onCostPriceChange,
    defaultListingType,
    onListingTypeChange,
    defaultHasWarranty,
    onHasWarrantyChange,
    defaultWarrantyUnit,
    onWarrantyUnitChange,
    defaultWarrantyDuration,
    onWarrantyDurationChange,
    defaultItemCondition,
    onItemConditionChange,
    defaultShippingMode,
    onShippingModeChange,
    defaultFreeShipping,
    onFreeShippingChange,
    defaultLocalPickup,
    onLocalPickupChange,
    defaultManufacturingTime,
    onManufacturingTimeChange,
    onSave,
    saving,
  } = props;
  return (
    <div className="space-y-5">
      <SettingGroup
        title="Produto"
        description="Defina os valores padrão usados ao criar produtos."
      >
        <SettingRow
          title="Descrição padrão"
          description="Usada quando nenhum texto é informado ao criar um produto."
          alignTop
        >
          <div className="space-y-1">
            <Label htmlFor="cfgDefaultDescription" className="sr-only">
              Descrição padrão
            </Label>
            <Textarea
              id="cfgDefaultDescription"
              value={defaultDescription}
              onChange={(e) => onDescriptionChange(e.target.value)}
              rows={5}
            />
          </div>
        </SettingRow>
        <SettingRow
          title="Preço de custo padrão (R$)"
          description="Preenche automaticamente o campo de custo no cadastro."
        >
          <div className="space-y-1">
            <Label htmlFor="cfgDefaultCostPrice" className="sr-only">
              Preço de custo padrão (R$)
            </Label>
            <Input
              id="cfgDefaultCostPrice"
              type="number"
              step="0.01"
              min="0"
              placeholder="0,00"
              value={defaultCostPrice}
              onChange={(e) => onCostPriceChange(e.target.value)}
            />
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title="Padrões de anúncio (Mercado Livre)"
        description="Aplicados por padrão, mas podem ser alterados por anúncio."
      >
        <SettingRow
          title="Listagem do anúncio"
          description="Tipo de plano a ser utilizado ao publicar."
        >
          <Select
            value={defaultListingType}
            onValueChange={onListingTypeChange}
          >
            <SelectTrigger className="w-full md:w-64">
              <SelectValue placeholder="Selecione" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gold_special">Premium</SelectItem>
              <SelectItem value="gold_pro">Clássico</SelectItem>
              <SelectItem value="bronze">Grátis</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          title="Condição do item"
          description="Padroniza o estado inicial do produto."
        >
          <Select
            value={defaultItemCondition}
            onValueChange={onItemConditionChange}
          >
            <SelectTrigger className="w-full md:w-64">
              <SelectValue placeholder="Selecione" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">Novo</SelectItem>
              <SelectItem value="used">Usado</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          title="Garantia"
          description="Ative se seus produtos oferecem garantia."
        >
          <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Possui garantia</p>
              <p className="text-xs text-muted-foreground">
                Exibe campos de prazo e unidade.
              </p>
            </div>
            <Switch
              id="cfgHasWarranty"
              checked={defaultHasWarranty}
              onCheckedChange={onHasWarrantyChange}
            />
          </div>
        </SettingRow>

        {defaultHasWarranty && (
          <SettingRow
            title="Detalhes da garantia"
            description="Escolha a unidade e a duração padrão."
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Select
                value={defaultWarrantyUnit}
                onValueChange={onWarrantyUnitChange}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Unidade" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dias">Dias</SelectItem>
                  <SelectItem value="meses">Meses</SelectItem>
                </SelectContent>
              </Select>
              <div className="space-y-1">
                <Label htmlFor="cfgWarrantyDuration" className="sr-only">
                  Prazo da garantia
                </Label>
                <Input
                  id="cfgWarrantyDuration"
                  type="number"
                  min="1"
                  step="1"
                  value={defaultWarrantyDuration}
                  onChange={(e) => onWarrantyDurationChange(e.target.value)}
                />
              </div>
            </div>
          </SettingRow>
        )}

        <SettingRow
          title="Frete"
          description="Modo padrão de envio para novos anúncios."
        >
          <Select
            value={defaultShippingMode}
            onValueChange={onShippingModeChange}
          >
            <SelectTrigger className="w-full md:w-72">
              <SelectValue placeholder="Selecione o modo de frete" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="me2">Mercado Envios</SelectItem>
              <SelectItem value="me1">Mercado Envios 1</SelectItem>
              <SelectItem value="custom">Personalizado</SelectItem>
              <SelectItem value="not_specified">Não especificado</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          title="Frete grátis"
          description="Define se anúncios nascem com frete grátis habilitado."
        >
          <Switch
            id="cfgFreeShipping"
            checked={defaultFreeShipping}
            onCheckedChange={onFreeShippingChange}
          />
        </SettingRow>

        <SettingRow
          title="Retirada local"
          description="Permite retirada em mãos por padrão."
        >
          <Switch
            id="cfgLocalPickup"
            checked={defaultLocalPickup}
            onCheckedChange={onLocalPickupChange}
          />
        </SettingRow>

        <SettingRow
          title="Disponibilidade (dias)"
          description="Prazo para o item ficar pronto para envio após a venda."
        >
          <div className="space-y-1">
            <Label htmlFor="cfgManufacturingTime" className="sr-only">
              Disponibilidade em dias
            </Label>
            <Input
              id="cfgManufacturingTime"
              type="number"
              min="0"
              step="1"
              value={defaultManufacturingTime}
              onChange={(e) => onManufacturingTimeChange(e.target.value)}
            />
          </div>
        </SettingRow>
      </SettingGroup>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Salvando..." : "Salvar"}
        </Button>
      </div>
    </div>
  );
}

function SettingGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-card/80 shadow-sm">
      <div className="border-b border-border/60 px-5 py-4">
        <p className="text-sm font-semibold leading-tight">{title}</p>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  );
}

function SettingRow({
  title,
  description,
  children,
  alignTop = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 px-5 py-4 md:grid-cols-[1.05fr_minmax(0,1.4fr)]">
      <div className="space-y-1">
        <p className="text-sm font-medium leading-tight">{title}</p>
        {description ? (
          <p className="text-xs text-muted-foreground leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      <div
        className={`flex w-full ${alignTop ? "items-start" : "items-center"} justify-end`}
      >
        <div className="w-full max-w-xl space-y-2">{children}</div>
      </div>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-48" />
      <div className="space-y-3 rounded-xl border border-border/70 bg-card/70 p-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
      <div className="space-y-3 rounded-xl border border-border/70 bg-card/70 p-4">
        <Skeleton className="h-6 w-52" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
