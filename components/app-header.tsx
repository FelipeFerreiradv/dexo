"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { Session } from "next-auth";
import { useTheme } from "next-themes";
import {
  Bell,
  CalendarDays,
  LogOut,
  Moon,
  Settings,
  Sun,
  User,
} from "lucide-react";
import { signOut } from "next-auth/react";

import { getApiBaseUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import ConfigModal from "./config-modal";
import { Skeleton } from "@/components/ui/skeleton";
import { ProfileModal } from "./profile-modal";

interface AppHeaderProps {
  session: Session | null;
}

export type NotificationEvent = {
  id: string;
  type: string;
  title: string;
  description: string;
  timestamp: string;
};

export function AppHeader({ session }: AppHeaderProps) {
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [configOpen, setConfigOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationEvent[]>([]);
  const [loadingNotif, setLoadingNotif] = useState(false);
  const [userInfo, setUserInfo] = useState<{
    id?: string;
    name?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  } | null>(null);
  const [loadingUser, setLoadingUser] = useState(false);

  const apiBase = useMemo(() => getApiBaseUrl(), []);

  const handleLogout = async () => {
    await signOut({ redirect: true, callbackUrl: "/login" });
  };

  const todayLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(new Date()),
    [],
  );

  useEffect(() => {
    if (!session) return;
    let active = true;
    const load = async () => {
      try {
        setLoadingNotif(true);
        const res = await fetch(
          `${apiBase}/dashboard/notifications?days=7&limit=30`,
          {
            credentials: "include",
            headers: session.user?.email
              ? { email: session.user.email }
              : undefined,
          },
        );
        if (!res.ok) throw new Error("Erro ao carregar notificações");
        const data = await res.json();
        if (active) {
          setNotifications(
            (data?.events || []).map((e: any) => ({
              ...e,
              timestamp: e.timestamp || new Date().toISOString(),
            })),
          );
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (active) setLoadingNotif(false);
      }
    };
    load();
    const id = setInterval(load, 300000); // 5 minutes
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [session, apiBase]);

  const loadUserProfile = useCallback(async () => {
    if (!session?.user?.email) return;
    setLoadingUser(true);
    try {
      const resp = await fetch(`${apiBase}/users/me`, {
        headers: { email: session.user.email },
      });
      if (!resp.ok) throw new Error("Erro ao carregar usuÃ¡rio");
      const data = await resp.json();
      setUserInfo({
        id: data.id,
        name: data.name,
        email: data.email,
        avatarUrl: data.avatarUrl,
      });
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingUser(false);
    }
  }, [apiBase, session?.user?.email]);

  useEffect(() => {
    loadUserProfile();
  }, [loadUserProfile]);

  if (!session) {
    router.push("/login");
    return null;
  }

  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-background/75 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-16 max-w-full w-full items-center gap-3 px-4 md:px-6">
        <div className="flex flex-1 items-center" />

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="hidden rounded-full border-border/60 bg-card/80 px-3 py-1 text-xs font-semibold text-foreground shadow-sm sm:inline-flex"
          >
            {todayLabel}
          </Button>
          <IconButton
            ariaLabel="Abrir calendário"
            icon={<CalendarDays className="size-4" />}
          />

          <NotificationsButton
            notifications={notifications}
            loading={loadingNotif}
          />

          <IconButton
            ariaLabel="Alternar tema"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            icon={
              <>
                <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              </>
            }
          />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                aria-busy={loadingUser}
                className="relative size-9 rounded-full border border-border/60 bg-card/80 text-foreground shadow-sm aria-busy:animate-pulse"
              >
                <Avatar className="size-9">
                  <AvatarImage
                    src={
                      userInfo?.avatarUrl ||
                      (session.user as any)?.image ||
                      "/avatar.png"
                    }
                    alt={userInfo?.name || session.user?.name || "Usuário"}
                  />
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                    {userInfo?.name?.slice(0, 2)?.toUpperCase() ||
                      session.user?.name?.slice(0, 2)?.toUpperCase() ||
                      session.user?.email?.slice(0, 2)?.toUpperCase() ||
                      "AD"}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align="end" forceMount>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">
                    {userInfo?.name || session.user?.name || "Usuário"}
                  </p>
                  <p className="text-xs leading-none text-muted-foreground">
                    {userInfo?.email || session.user?.email}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setProfileOpen(true)}>
                <User className="mr-2 size-4" />
                <span>Perfil</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setConfigOpen(true)}>
                <Settings className="mr-2 size-4" />
                <span>Configurações</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="cursor-pointer text-destructive focus:text-destructive"
                onClick={handleLogout}
              >
                <LogOut className="mr-2 size-4" />
                <span>Sair</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ProfileModal
        open={profileOpen}
        onOpenChange={setProfileOpen}
        session={session}
        onRequestEdit={() => setConfigOpen(true)}
      />

      <ConfigModal
        open={configOpen}
        onOpenChange={(v) => setConfigOpen(v)}
        onUserUpdated={loadUserProfile}
      />
    </header>
  );
}

function NotificationsButton({
  notifications,
  loading,
}: {
  notifications: NotificationEvent[];
  loading: boolean;
}) {
  const hasNew = notifications.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Notificações"
          className="relative size-9 rounded-full border border-border/60 bg-card/80 text-foreground shadow-sm transition hover:border-primary/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <div className="relative">
            <Bell className="size-4" />
            {hasNew ? (
              <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-primary" />
            ) : null}
          </div>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80" align="end" forceMount>
        <DropdownMenuLabel className="flex items-center justify-between text-xs uppercase tracking-[0.12em] text-muted-foreground">
          <span>Notificações</span>
          {hasNew ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
              {notifications.length}
            </span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="max-h-[360px] space-y-2 overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : notifications.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              Sem notificações recentes.
            </p>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
              >
                <p className="text-sm font-semibold text-foreground">
                  {n.title}
                </p>
                <p className="text-xs text-muted-foreground">{n.description}</p>
                <p className="text-[11px] text-muted-foreground/80">
                  {formatTimeAgo(n.timestamp)}
                </p>
              </div>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function formatTimeAgo(ts: string) {
  const date = new Date(ts);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins} min atrás`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h atrás`;
  const days = Math.floor(hours / 24);
  return `${days} d atrás`;
}

function IconButton({
  ariaLabel,
  icon,
  onClick,
}: {
  ariaLabel: string;
  icon: ReactNode;
  onClick?: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={ariaLabel}
      onClick={onClick}
      className="relative size-9 rounded-full border border-border/60 bg-card/80 text-foreground shadow-sm transition hover:border-primary/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {icon}
    </Button>
  );
}
