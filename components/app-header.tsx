"use client";

import { useRouter } from "next/navigation";
import { Session } from "next-auth";
import { useTheme } from "next-themes";
import { Search, Moon, Sun, User, Settings, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { signOut } from "next-auth/react";
import { useState } from "react";
import ConfigModal from "./config-modal";

interface AppHeaderProps {
  session: Session | null;
}

export function AppHeader({ session }: AppHeaderProps) {
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [configOpen, setConfigOpen] = useState(false);

  // Se não houver sessão, redireciona para login
  if (!session) {
    router.push("/login");
    return null;
  }

  const handleLogout = async () => {
    await signOut({ redirect: true, callbackUrl: "/login" });
  };

  return (
    <header className="sticky top-0 z-50 flex h-14 items-center gap-4 border-b bg-background px-4 md:px-6">
      <SidebarTrigger className="-ml-1" />

      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold text-foreground">Dexo Company</h1>
      </div>

      <div className="flex-1 flex items-center justify-center max-w-xl mx-auto">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Buscar produtos, pedidos, clientes..."
            className="w-full pl-10 bg-muted/50"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Alternar tema"
        >
          <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="relative size-8 rounded-full">
              <Avatar className="size-8">
                <AvatarImage src="/avatar.png" alt="Usuário" />
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                  AD
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="end" forceMount>
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none">
                  {session.user?.name || "Usuário"}
                </p>
                <p className="text-xs leading-none text-muted-foreground">
                  {session.user?.email}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <User className="mr-2 size-4" />
              <span>Perfil</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setConfigOpen(true)}>
              <Settings className="mr-2 size-4" />
              <span>Configurações</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive cursor-pointer"
              onClick={handleLogout}
            >
              <LogOut className="mr-2 size-4" />
              <span>Sair</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Config modal */}
      <ConfigModal open={configOpen} onOpenChange={(v) => setConfigOpen(v)} />
    </header>
  );
}
