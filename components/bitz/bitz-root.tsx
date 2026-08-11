"use client";

import dynamic from "next/dynamic";
import type { Session } from "next-auth";

import { AI_MODULE_ENABLED } from "./bitz-constants";

/**
 * Ponto de montagem do Bitz — o ÚNICO arquivo do módulo que entra no shell de
 * todas as páginas.
 *
 * Ele é deliberadamente minúsculo: importa `next/dynamic` (já presente no
 * bundle), uma const booleana e um tipo. Mascote, hooks, ícones, markdown e
 * painel vivem em `bitz-widget.tsx`, que é carregado por `dynamic()` e
 * portanto NÃO faz parte do bundle inicial.
 *
 * Por que este arquivo existe separado de `bitz-widget.tsx`: a primeira versão
 * fazia `if (!FLAG) return null` no próprio widget. Medindo o build, o shell
 * cresceu 2,9 KB gz IGUALMENTE com a flag ligada e desligada — o early-return
 * é runtime, e os imports do topo do módulo entram no bundle de qualquer jeito.
 * Só a fronteira de `dynamic()` empurra mascote/hooks/ícones para fora.
 *
 * CUSTO MEDIDO no shell de todas as páginas (build de produção, gzip):
 *   sem o Bitz montado ......... 231,3 KB
 *   com o Bitz (flag ON ou OFF)  232,8 KB   → +1,5 KB (+0,65 %)
 * Os dois estados da flag pesam IGUAL: o que ela decide não é o tamanho do
 * shell, e sim se o chunk do widget chega a ser BUSCADO em runtime. Com a flag
 * desligada, sem sessão ou sem plano, são zero requisições e zero bytes
 * adicionais — mas o shim abaixo continua no bundle.
 *
 * TRÊS PORTAS, nesta ordem:
 *  1. `AI_MODULE_ENABLED` — flag de build. Fechada ⇒ o chunk não é buscado.
 *  2. Sessão autenticada  — fechada ⇒ o chunk não é buscado.
 *  3. Plano do tenant     — checada DENTRO do widget (GET /ai/entitlement).
 */
const BitzWidget = dynamic(
  () => import("./bitz-widget").then((m) => m.BitzWidget),
  { ssr: false },
);

export function BitzRoot({ session }: { session: Session | null }) {
  if (!AI_MODULE_ENABLED) return null;
  if (!session?.user) return null;
  return <BitzWidget session={session} />;
}

export default BitzRoot;
