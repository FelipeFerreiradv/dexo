"use client";

import { useEffect, useState } from "react";
import { getApiBaseUrl } from "@/lib/api";
import type { AccountHealthProblem } from "@/app/lib/account-health-messages";

// Cache de módulo: a faixa do topo e o bloco da aba de integração perguntam a
// mesma coisa na mesma tela. Uma requisição serve os dois, e quem buscar
// primeiro AVISA os outros — assim, quando o bloco da aba relê depois de uma
// reconexão, a faixa do topo se atualiza junto em vez de esperar 5 min.
const TTL_MS = 60 * 1000;
let cache: { email: string; at: number; contas: AccountHealthProblem[] } | null =
  null;
let emVoo: { email: string; promise: Promise<AccountHealthProblem[]> } | null =
  null;
const ouvintes = new Set<(email: string, contas: AccountHealthProblem[]) => void>();

export async function carregarSaudeDasContas(
  email: string,
  opts: { ignorarCache?: boolean } = {},
): Promise<AccountHealthProblem[]> {
  const agora = Date.now();
  if (
    !opts.ignorarCache &&
    cache &&
    cache.email === email &&
    agora - cache.at < TTL_MS
  ) {
    return cache.contas;
  }
  if (emVoo && emVoo.email === email) return emVoo.promise;

  const promise = (async () => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/marketplace/accounts/health`, {
        headers: { email },
      });
      if (!res.ok) return cache?.email === email ? cache.contas : [];
      const data = await res.json();
      const contas: AccountHealthProblem[] = Array.isArray(data?.contas)
        ? data.contas
        : [];
      cache = { email, at: Date.now(), contas };
      for (const ouvir of ouvintes) ouvir(email, contas);
      return contas;
    } catch {
      // Aviso é informação ADICIONAL: falha de rede não pode quebrar a tela.
      return cache?.email === email ? cache.contas : [];
    } finally {
      emVoo = null;
    }
  })();
  emVoo = { email, promise };
  return promise;
}

/**
 * Contas com problema do tenant.
 *
 * - `acompanhar` (faixa do topo): repete a cada 5 min e ao voltar o foco, sem
 *   consultar com a aba em segundo plano — mesmo desenho do sino do cabeçalho.
 *   O foco da JANELA também conta: o OAuth de reconexão abre um popup e a aba
 *   principal nunca fica oculta.
 * - `sempreAtual` (bloco da aba de integração): ignora o cache ao montar. A
 *   aba remonta o bloco depois de reconectar, e é ali que o aviso não pode
 *   ficar velho.
 */
export function useAccountHealth(
  email: string | null | undefined,
  opts: { acompanhar?: boolean; sempreAtual?: boolean } = {},
): AccountHealthProblem[] {
  const [contas, setContas] = useState<AccountHealthProblem[]>([]);
  const acompanhar = Boolean(opts.acompanhar);
  const sempreAtual = Boolean(opts.sempreAtual);

  useEffect(() => {
    if (!email) {
      setContas([]);
      return;
    }
    let ativo = true;
    const ouvir = (e: string, novas: AccountHealthProblem[]) => {
      if (ativo && e === email) setContas(novas);
    };
    ouvintes.add(ouvir);

    const carregar = async (ignorarCache = false) => {
      if (typeof document !== "undefined" && document.hidden) return;
      const r = await carregarSaudeDasContas(email, { ignorarCache });
      if (ativo) setContas(r);
    };
    void carregar(sempreAtual);

    if (!acompanhar) {
      return () => {
        ativo = false;
        ouvintes.delete(ouvir);
      };
    }
    const id = setInterval(() => void carregar(true), 5 * 60 * 1000);
    const aoVoltar = () => {
      if (ativo && !document.hidden) void carregar();
    };
    document.addEventListener("visibilitychange", aoVoltar);
    window.addEventListener("focus", aoVoltar);
    return () => {
      ativo = false;
      ouvintes.delete(ouvir);
      clearInterval(id);
      document.removeEventListener("visibilitychange", aoVoltar);
      window.removeEventListener("focus", aoVoltar);
    };
  }, [email, acompanhar, sempreAtual]);

  return contas;
}
