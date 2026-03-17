"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2, Lock, Mail } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DexoLoginFormProps {
  callbackUrl?: string;
}

export function DexoLoginForm({ callbackUrl = "/" }: DexoLoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        setError("E-mail ou senha invalidos. Verifique seus dados.");
      } else {
        router.push(callbackUrl);
        router.refresh();
      }
    } catch {
      setError("Ocorreu um erro ao tentar fazer login. Tente novamente.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-2xl border border-destructive/40 bg-destructive/15 px-4 py-3 text-sm text-destructive shadow-[0_12px_40px_-28px_rgba(0,0,0,0.6)]"
        >
          {error}
        </div>
      )}

      <div className="space-y-2">
        <label
          htmlFor="email"
          className="text-sm font-medium text-foreground/90"
        >
          E-mail
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
            <Mail className="h-4 w-4" aria-hidden />
          </span>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="voce@dexo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isLoading}
            className={cn(
              "h-12 rounded-full border border-border/70 bg-input/40 text-base text-foreground placeholder:text-muted-foreground/80 shadow-[0_18px_50px_-34px_rgba(0,0,0,0.85)] backdrop-blur-xl",
              "focus-visible:border-ring/90 focus-visible:ring-ring/70",
              "transition-[border,box-shadow,transform] duration-200 ease-out focus-visible:shadow-[0_18px_40px_-26px_color-mix(in_srgb,var(--ring)70%,transparent)] focus-visible:translate-y-[-1px]",
            )}
            required
          />
        </div>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="password"
          className="text-sm font-medium text-foreground/90"
        >
          Senha
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground/70">
            <Lock className="h-4 w-4" aria-hidden />
          </span>
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder="Sua senha segura"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={isLoading}
            className={cn(
              "h-12 rounded-full border border-border/70 bg-input/40 pr-12 text-base text-foreground placeholder:text-muted-foreground/80 shadow-[0_18px_50px_-34px_rgba(0,0,0,0.85)] backdrop-blur-xl",
              "focus-visible:border-ring/90 focus-visible:ring-ring/70",
              "transition-[border,box-shadow,transform] duration-200 ease-out focus-visible:shadow-[0_18px_40px_-26px_color-mix(in_srgb,var(--ring)70%,transparent)] focus-visible:translate-y-[-1px]",
            )}
            required
          />
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-full p-1"
            aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" aria-hidden />
            ) : (
              <Eye className="h-4 w-4" aria-hidden />
            )}
          </button>
        </div>
      </div>

      <div className="pt-2">
        <Button
          type="submit"
          disabled={isLoading}
          className="h-12 w-full rounded-full bg-primary/90 text-base font-semibold uppercase tracking-tight text-primary-foreground shadow-[0_22px_70px_-38px_color-mix(in_srgb,var(--primary)85%,transparent)] transition-all duration-200 hover:bg-primary focus-visible:bg-primary focus-visible:ring-2 focus-visible:ring-ring/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              Entrando...
            </>
          ) : (
            "Entrar"
          )}
        </Button>
        <p className="mt-3 text-center text-xs text-muted-foreground/80">
          Continuar indica que voce concorda com os termos de uso da Dexo.
        </p>
      </div>
    </form>
  );
}
