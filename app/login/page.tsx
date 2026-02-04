import { LoginForm } from "@/components/login/login-form";
import { LoginHero } from "@/components/login/login-hero";
import { Package } from "lucide-react";

export const metadata = {
  title: "Login | Nexos Platform",
  description: "Acesse o sistema de gestao de estoque Nexos Platform",
};

export default function LoginPage() {
  return (
    <main className="h-screen w-screen flex overflow-hidden">
      {/* Left Side - Hero Section (Hidden on mobile) */}
      <section className="hidden lg:flex lg:w-1/2 xl:w-3/5" aria-hidden="true">
        <LoginHero />
      </section>

      {/* Right Side - Login Form */}
      <section className="w-full lg:w-1/2 xl:w-2/5 flex flex-col bg-[#F2F2F0]">
        {/* Mobile Header */}
        <header className="lg:hidden p-0 bg-gradient-to-r from-[#F2E205] to-[#F2CB05]">
          <div className="flex items-center gap-3 p-6">
            <div className="w-10 h-10 rounded-xl bg-[#0D0D0D] flex items-center justify-center">
              <Package className="w-5 h-5 text-[#F2E205]" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-[#0D0D0D]">
                Nexos Platform
              </h1>
              <p className="text-xs text-[#0D0D0D]/70">Gestao de Estoque</p>
            </div>
          </div>
        </header>

        {/* Form Container */}
        <div className="flex-1 flex items-center justify-center p-6 sm:p-8 lg:p-0">
          <div className="w-full max-w-md px-6 sm:px-8 lg:px-12">
            {/* Header */}
            <div className="mb-8 text-center lg:text-left">
              <h2 className="text-2xl sm:text-3xl font-bold text-[#0D0D0D]">
                Bem-vindo de volta
              </h2>
              <p className="mt-2 text-[#0D0D0D]/60">
                Digite suas credenciais para acessar o sistema
              </p>
            </div>

            {/* Login Form Component */}
            <LoginForm />

            {/* Divider */}
            <div className="relative my-8">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[#0D0D0D]/10" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-4 bg-[#F2F2F0] text-[#0D0D0D]/50">
                  Precisa de ajuda?
                </span>
              </div>
            </div>

            {/* Help Section */}
            <div className="text-center">
              <p className="text-sm text-[#0D0D0D]/60">
                Entre em contato com o suporte para recuperar seu acesso ou
                criar uma nova conta.
              </p>
              <button
                type="button"
                className="mt-4 inline-flex items-center text-sm font-semibold text-[#0D0D0D] hover:text-[#F2CB05] transition-colors"
              >
                Falar com Suporte
              </button>
            </div>

            {/* Footer */}
            <footer className="mt-12 text-center lg:hidden">
              <p className="text-xs text-[#0D0D0D]/40">
                2025 Nexos Platform. Todos os direitos reservados.
              </p>
            </footer>
          </div>
        </div>
      </section>
    </main>
  );
}
