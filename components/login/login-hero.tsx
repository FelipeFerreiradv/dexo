"use client";

import { Package, TrendingUp, ShieldCheck } from "lucide-react";

export function LoginHero() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-[#F2E205] via-[#F2CB05] to-[#F2DE77]">
      {/* Decorative Pattern */}
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-0 left-0 w-full h-full">
          <svg
            className="w-full h-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <defs>
              <pattern
                id="grid"
                width="10"
                height="10"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M 10 0 L 0 0 0 10"
                  fill="none"
                  stroke="#0D0D0D"
                  strokeWidth="0.5"
                />
              </pattern>
            </defs>
            <rect width="100" height="100" fill="url(#grid)" />
          </svg>
        </div>
      </div>

      {/* Content */}
      <div className="relative z-10 flex flex-col justify-center h-full p-8 lg:p-12 w-full">
        <div className="max-w-lg">
          {/* Logo/Brand Area */}
          <div className="mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[#0D0D0D] shadow-lg mb-6">
              <Package className="w-8 h-8 text-[#F2E205]" />
            </div>
            <h1 className="text-3xl lg:text-4xl font-bold text-[#0D0D0D] leading-tight">
              Dexos Plataform
            </h1>
            <p className="mt-2 text-lg text-[#0D0D0D]/80 font-medium">
              Sistema de Gestao de Estoque
            </p>
          </div>

          {/* Description */}
          <p className="text-[#0D0D0D]/70 text-base lg:text-lg leading-relaxed mb-10">
            Gerencie seu estoque de forma centralizada com integracoes diretas
            ao Mercado Livre e Shopee. Simplifique suas operacoes e tome
            decisoes baseadas em dados.
          </p>

          {/* Features */}
          <div className="space-y-4">
            <FeatureItem
              icon={<Package className="w-5 h-5" />}
              title="Controle Centralizado"
              description="Gerencie todo o seu inventario em um unico lugar"
            />
            <FeatureItem
              icon={<TrendingUp className="w-5 h-5" />}
              title="Relatorios em Tempo Real"
              description="Acompanhe vendas e movimentacoes instantaneamente"
            />
            <FeatureItem
              icon={<ShieldCheck className="w-5 h-5" />}
              title="Seguranca Garantida"
              description="Seus dados protegidos com criptografia avancada"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="mt-auto pt-8">
          <p className="text-sm text-[#0D0D0D]/50">
            2025 GHD Platform. Todos os direitos reservados.
          </p>
        </div>
      </div>

      {/* Decorative Circles */}
      <div className="absolute -bottom-32 -right-32 w-96 h-96 rounded-full bg-[#0D0D0D]/5" />
      <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-white/20" />
    </div>
  );
}

interface FeatureItemProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function FeatureItem({ icon, title, description }: FeatureItemProps) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-[#0D0D0D]/10 flex items-center justify-center text-[#0D0D0D]">
        {icon}
      </div>
      <div>
        <h3 className="font-semibold text-[#0D0D0D]">{title}</h3>
        <p className="text-sm text-[#0D0D0D]/60">{description}</p>
      </div>
    </div>
  );
}
