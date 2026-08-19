// BLOCO H — histórico da venda: o lado do navegador.
//
// Módulo PURO + um fetch. Toda a decisão de "como este evento aparece" mora
// aqui em função pura e testada; o JSX só desenha o que este arquivo devolve.
//
// DUAS FLAGS, e elas são mesmo duas:
//   NEXT_PUBLIC_SALE_TIMELINE_ENABLED  → mostra/esconde o botão (build-time,
//                                        inlinada no bundle: exige `npm run build`)
//   SALE_TIMELINE_ENABLED              → grava e lê os eventos (runtime da API,
//                                        liga com `pm2 restart`)
// Vivem em processos diferentes, por isso não dá para ter uma só. Ligar apenas
// a de UI não quebra nada: a rota devolve `[]` e a tela mostra o vazio honesto.
//
// ⚠️ TODA VENDA ANTERIOR AO DDL TEM HISTÓRICO VAZIO. A tabela nasceu hoje e
// nada foi retroagido — não há de onde. O estado vazio precisa dizer isso com
// todas as letras, senão o operador abre uma venda antiga e conclui que a
// funcionalidade está quebrada.

import { getApiBaseUrl } from "@/lib/api";
import { paymentMethodLabel } from "@/app/lib/payment-methods";

// Referência literal a process.env.NEXT_PUBLIC_* para o Next inlinar (mesma
// convenção de pdv-actions.ts:15-19 — não há helper central de flags).
const SALE_TIMELINE_UI_ENABLED =
  process.env.NEXT_PUBLIC_SALE_TIMELINE_ENABLED === "true";

/** Botão "Histórico" visível? Flag OFF ⇒ a linha renderiza como hoje. */
export function isSaleTimelineUiEnabled(): boolean {
  return SALE_TIMELINE_UI_ENABLED;
}

/**
 * Egress: 30 por página. Uma venda muito editada não vira payload sem fim, e
 * o backend clampa em 200 de qualquer jeito (sale-timeline.ts:115).
 */
export const SALE_TIMELINE_PAGE_SIZE = 30;

export interface SaleTimelineEvent {
  id: string;
  /**
   * `string`, NÃO união fechada: o backend guarda o tipo como texto justamente
   * para que um tipo novo não exija `ALTER TYPE`. Uma tela que só sabe lidar
   * com 5 valores conhecidos anularia essa escolha — aqui, tipo desconhecido
   * aparece cru em vez de sumir.
   */
  type: string;
  message: string | null;
  actorName: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Eventos de UMA venda, mais recente primeiro.
 *
 * `before` é o cursor por data — passe o `createdAt` do último evento já
 * carregado para pegar a página seguinte.
 */
export async function fetchSaleTimeline(
  receivableId: string,
  email: string,
  opts?: { before?: string; signal?: AbortSignal },
): Promise<SaleTimelineEvent[]> {
  const params = new URLSearchParams({
    limit: String(SALE_TIMELINE_PAGE_SIZE),
  });
  if (opts?.before) params.set("before", opts.before);
  const res = await fetch(
    `${getApiBaseUrl()}/finance/receivables/${receivableId}/timeline?${params}`,
    { headers: { email }, signal: opts?.signal },
  );
  if (!res.ok) throw new Error("Erro ao carregar o histórico da venda");
  const data = await res.json();
  return (data?.events ?? []) as SaleTimelineEvent[];
}

export type SaleEventTone = "neutral" | "success" | "danger" | "info";

// Protótipo NULO: com objeto literal comum, um `type` vindo do banco valendo
// "toString" devolveria uma FUNÇÃO em vez de cair no `?? type`, e o React
// estouraria ao renderizá-la. O tipo é texto livre no schema justamente para
// aceitar valores novos — então tratar valor inesperado é obrigação daqui.
const TIPO_ROTULO: Record<string, string> = Object.assign(Object.create(null), {
  CREATED: "Criada",
  UPDATED: "Alterada",
  PAID: "Recebida",
  REVERSED: "Cancelada",
  FISCAL_EMITTED: "Nota fiscal",
});

const TIPO_TOM: Record<string, SaleEventTone> = Object.assign(
  Object.create(null),
  {
    CREATED: "neutral",
    UPDATED: "info",
    PAID: "success",
    REVERSED: "danger",
    FISCAL_EMITTED: "info",
  },
);

/** Rótulo curto do evento. Tipo desconhecido volta cru — nunca vira "—". */
export function saleEventLabel(type: string): string {
  return TIPO_ROTULO[type] ?? type;
}

/** Cor do evento. Tipo desconhecido cai em neutro, que não afirma nada. */
export function saleEventTone(type: string): SaleEventTone {
  return TIPO_TOM[type] ?? "neutral";
}

/**
 * Linha secundária: o que os `details` acrescentam ao `message`, e NADA além
 * disso. Repetir o que a mensagem já diz é ruído — e a mensagem é sempre a
 * manchete (o backend a monta pronta, a tela não frase-monta a partir do tipo).
 *
 * Devolve `null` quando não há o que acrescentar.
 */
export function saleEventDetailLine(
  type: string,
  details: Record<string, unknown> | null | undefined,
): string | null {
  if (!details) return null;
  const partes: string[] = [];

  const num = (chave: string): number | null => {
    const v = details[chave];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  switch (type) {
    case "CREATED": {
      // A mensagem já diz "Venda criada com N itens" — falta o valor e a forma.
      const total = num("totalAmount");
      if (total !== null) partes.push(formatarValor(total));
      const forma = details.paymentMethod;
      if (typeof forma === "string" && forma)
        partes.push(paymentMethodLabel(forma));
      break;
    }
    case "PAID": {
      const total = num("totalAmount");
      if (total !== null) partes.push(formatarValor(total));
      const baixados = num("productsDeducted");
      if (baixados !== null && baixados > 0)
        partes.push(
          `${baixados} ${plural(baixados, "produto")} baixado${baixados === 1 ? "" : "s"}`,
        );
      break;
    }
    case "REVERSED": {
      const total = num("totalAmount");
      if (total !== null) partes.push(formatarValor(total));
      const devolvidos = num("restoredProducts");
      if (devolvidos !== null && devolvidos > 0)
        partes.push(
          `${devolvidos} ${plural(devolvidos, "produto")} devolvido${devolvidos === 1 ? "" : "s"} ao estoque`,
        );
      break;
    }
    case "FISCAL_EMITTED": {
      // O número já está na mensagem; a série é o que falta para localizar a
      // nota no módulo fiscal.
      const modelo = details.modelo;
      if (typeof modelo === "string" && modelo)
        partes.push(modelo === "65" ? "NFC-e (modelo 65)" : `Modelo ${modelo}`);
      const serie = num("serie");
      if (serie !== null) partes.push(`série ${serie}`);
      break;
    }
    // UPDATED não entra: a mensagem já lista os campos alterados, e repetir a
    // mesma lista logo abaixo seria ruído puro.
    default:
      return null;
  }

  return partes.length > 0 ? partes.join(" · ") : null;
}

function plural(n: number, palavra: string): string {
  return n === 1 ? palavra : `${palavra}s`;
}

// Mesma configuração do `formatToBRL` (currency-input.tsx:35-41), reescrita
// aqui de propósito: este módulo é puro e testado em ambiente node, e importar
// um `.tsx` arrastaria React para dentro dele sem necessidade.
function formatarValor(v: number): string {
  return `R$ ${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v)}`;
}

/**
 * Data + hora do evento.
 *
 * timeZone FIXO (fuso do negócio), igual ao livro do dia: a hora de um evento
 * não pode variar com o relógio da máquina que abre a página, e um render
 * determinístico nunca diverge entre SSR e browser (hydration).
 */
export function formatEventWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    timeZone: "America/Sao_Paulo",
  })} ${d.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  })}`;
}

/**
 * Quem fez. `null` no banco = ação de SISTEMA (cadeia automática do PDV, job),
 * que é diferente de "não sabemos quem foi" — e a tela precisa dizer a coisa
 * certa, senão vira suspeita de dado perdido.
 */
export function saleEventActor(actorName: string | null | undefined): string {
  return actorName && actorName.trim() ? actorName : "Sistema";
}
