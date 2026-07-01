// CRM de Orçamentos — tipos, tokens e regras de derivação/transição.
// Compartilhado por budget-crm, budget-kanban e budget-stage-list. Espelha o
// modelo do backend: `status` (ciclo de vida) + `pipelineStage` (funil), com a
// COLUNA do kanban DERIVADA em read-time. Nada aqui muda a semântica de status.

export type BudgetStatus = "ABERTO" | "CONVERTIDO" | "EXPIRADO" | "CANCELADO";
export type BudgetStage =
  | "NOVO"
  | "EM_NEGOCIACAO"
  | "PROPOSTA_ENVIADA"
  | "GANHO"
  | "PERDIDO"
  | "CANCELADO";

// As 6 colunas do funil (na ordem de exibição). A chave GANHO = "Fechado (ganho)".
export type ColumnKey =
  | "NOVO"
  | "EM_NEGOCIACAO"
  | "PROPOSTA_ENVIADA"
  | "GANHO"
  | "PERDIDO"
  | "CANCELADO";

export const COLUMN_ORDER: ColumnKey[] = [
  "NOVO",
  "EM_NEGOCIACAO",
  "PROPOSTA_ENVIADA",
  "GANHO",
  "PERDIDO",
  "CANCELADO",
];

// Colunas "abertas" — as únicas de onde se pode arrastar e para onde o PATCH
// /stage é aceito (orçamento ABERTO).
export const OPEN_COLUMNS: ColumnKey[] = [
  "NOVO",
  "EM_NEGOCIACAO",
  "PROPOSTA_ENVIADA",
];

export function isOpenColumn(c: ColumnKey): boolean {
  return OPEN_COLUMNS.includes(c);
}

export const COLUMN_LABEL: Record<ColumnKey, string> = {
  NOVO: "Novo",
  EM_NEGOCIACAO: "Em negociação",
  PROPOSTA_ENVIADA: "Proposta enviada",
  GANHO: "Fechado (ganho)",
  PERDIDO: "Perdido / Desistido",
  CANCELADO: "Cancelado",
};

// Pílulas de estágio no padrão Dexo (mesma família de classes do
// STATUS_STYLES de budget-list.tsx). Verde = ganho; muted/rose = cancelado/perdido.
export const COLUMN_STYLES: Record<ColumnKey, string> = {
  NOVO: "bg-muted text-foreground/80 dark:bg-muted/40",
  EM_NEGOCIACAO:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  PROPOSTA_ENVIADA:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200",
  GANHO: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  PERDIDO: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  CANCELADO: "bg-muted text-muted-foreground",
};

// Acento sutil no topo da coluna (barra) — reforça a identidade sem poluir.
export const COLUMN_ACCENT: Record<ColumnKey, string> = {
  NOVO: "bg-foreground/25",
  EM_NEGOCIACAO: "bg-amber-400",
  PROPOSTA_ENVIADA: "bg-[color:var(--primary)]",
  GANHO: "bg-green-500",
  PERDIDO: "bg-rose-400",
  CANCELADO: "bg-muted-foreground/40",
};

export interface CrmBudget {
  id: string;
  document: string | null;
  reason: string | null;
  notes?: string | null;
  totalAmount: number;
  validUntil: string | null;
  status: BudgetStatus;
  pipelineStage?: BudgetStage | null;
  lostReason?: string | null;
  customer: { id: string; name: string; cpf: string | null } | null;
  unidadeId?: string | null;
  unidade?: { id: string; name: string } | null;
  vendedorId?: string | null;
  vendedor?: { id: string; name: string | null; email: string } | null;
  receivableId?: string | null;
}

// EXPIRADO é um BADGE (não coluna): status ABERTO + validade vencida. A API já
// devolve status="EXPIRADO" nesses casos (applyExpiredFlag), mas cobrimos os dois.
export function isExpired(b: CrmBudget): boolean {
  if (b.status === "EXPIRADO") return true;
  if (b.status !== "ABERTO" || !b.validUntil) return false;
  return new Date(b.validUntil).getTime() < Date.now();
}

// Coluna exibida (derivação read-time — espelha a tabela do plano).
export function deriveColumn(b: CrmBudget): ColumnKey {
  if (b.status === "CONVERTIDO") return "GANHO";
  if (b.status === "CANCELADO") {
    return b.pipelineStage === "PERDIDO" ? "PERDIDO" : "CANCELADO";
  }
  // ABERTO ou EXPIRADO (ABERTO por baixo)
  const s = b.pipelineStage;
  if (s === "NOVO" || s === "EM_NEGOCIACAO" || s === "PROPOSTA_ENVIADA")
    return s;
  return "NOVO";
}

// ── Matriz de transições ──────────────────────────────────────────────────
export type Transition =
  | { kind: "noop" }
  | { kind: "blocked"; reason: string }
  | { kind: "stage"; stage: BudgetStage } // open→open (PATCH /stage)
  | { kind: "convert" } // →Fechado (POST /convert, com confirmação)
  | { kind: "cancel"; pipelineStage: "PERDIDO" | "CANCELADO" }; // POST /cancel

export const BLOCKED_FROM_WON =
  "Este orçamento já virou uma venda (Conta a Receber). Para reverter, estorne a conta na aba Contas a Receber.";
export const BLOCKED_REOPEN =
  "Reabrir um orçamento cancelado/perdido não é suportado. Crie um novo orçamento se necessário.";

export function planTransition(from: ColumnKey, to: ColumnKey): Transition {
  if (from === to) return { kind: "noop" };
  if (from === "GANHO") return { kind: "blocked", reason: BLOCKED_FROM_WON };
  if (from === "CANCELADO" || from === "PERDIDO") {
    return { kind: "blocked", reason: BLOCKED_REOPEN };
  }
  // `from` é uma coluna aberta:
  if (isOpenColumn(to)) return { kind: "stage", stage: to as BudgetStage };
  if (to === "GANHO") return { kind: "convert" };
  if (to === "PERDIDO") return { kind: "cancel", pipelineStage: "PERDIDO" };
  if (to === "CANCELADO") return { kind: "cancel", pipelineStage: "CANCELADO" };
  return { kind: "blocked", reason: "Movimento não permitido." };
}
