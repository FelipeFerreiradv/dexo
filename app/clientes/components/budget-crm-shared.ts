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
  GANHO: "Fechado / ganho",
  PERDIDO: "Perdido / desistiu",
  CANCELADO: "Cancelado",
};

// Índice de etiqueta industrial (mono) — reforça o "lado sistema" (manual técnico).
export const COLUMN_INDEX: Record<ColumnKey, string> = {
  NOVO: "01",
  EM_NEGOCIACAO: "02",
  PROPOSTA_ENVIADA: "03",
  GANHO: "04",
  PERDIDO: "05",
  CANCELADO: "06",
};

// Pílulas de estágio (padrão Dexo). Verde Operação = ganho; petróleo médio =
// proposta; amarelo sinalização = negociação; concreto/terracota = cancel/perdido.
export const COLUMN_STYLES: Record<ColumnKey, string> = {
  NOVO: "bg-muted text-muted-foreground",
  EM_NEGOCIACAO:
    "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  PROPOSTA_ENVIADA:
    "bg-[#1b3a4d]/10 text-[#1b3a4d] dark:bg-[#1b3a4d]/50 dark:text-[#9cc3d6]",
  GANHO:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  PERDIDO: "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100",
  CANCELADO: "bg-muted text-muted-foreground",
};

// Barra-acento (spine) da coluna e do card — cores da paleta oficial:
// Aço · Amarelo Sinalização · Petróleo Médio · Verde Operação · terracota · Concreto.
export const COLUMN_ACCENT: Record<ColumnKey, string> = {
  NOVO: "bg-[#7b8590]",
  EM_NEGOCIACAO: "bg-[#f2c419]",
  PROPOSTA_ENVIADA: "bg-[#1b3a4d]",
  GANHO: "bg-[#2c5f4f]",
  PERDIDO: "bg-[#b23a2e]",
  CANCELADO: "bg-[#9ca39c]",
};

// Helpers de tipografia da marca (arbitrary font-family → vars do layout.tsx).
export const FONT_DISPLAY = "[font-family:var(--font-bricolage)]"; // Bricolage
export const FONT_SERIF = "[font-family:var(--font-fraunces)]"; // Fraunces
export const FONT_MONO = "font-mono"; // JetBrains Mono (--font-mono)

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
