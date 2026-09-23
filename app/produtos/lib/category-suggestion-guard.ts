/**
 * Quem manda na categoria de cada canal no cadastro de produto: a sugestão
 * automática ou a pessoa.
 *
 * O defeito (22/09/2026): o efeito de medidas do modal copiava a categoria
 * ATUAL — inclusive a escolhida à mão — para o registro de "valores
 * auto-detectados". Dali em diante a escolha manual passava por automática e a
 * sugestão seguinte (título digitado, resposta atrasada do servidor, opções
 * recarregadas) a sobrescrevia. Clientes publicaram na categoria errada sem
 * perceber.
 *
 * Regra:
 *  - enquanto ninguém escolheu, a sugestão pode preencher e atualizar;
 *  - escolheu à mão ⇒ nenhuma sugestão sobrescreve (só a ação explícita
 *    "usar sugestão");
 *  - resposta de uma requisição mais antiga que a última disparada é descartada.
 *
 * Puro e sem React: o modal guarda o estado num `ref` (os efeitos do
 * react-hook-form disparam SÍNCRONOS dentro de `setValue`/`reset`, então o
 * estado tem de estar certo antes de qualquer `setValue`).
 */

export type CategoryChannel = "ml" | "shopee" | "magalu" | "olx" | "fb";
export type CategoryOrigin = "empty" | "auto" | "manual";

export interface ChannelGuard {
  origin: CategoryOrigin;
  /** Último valor aplicado pela sugestão automática neste canal. */
  lastAutoValue: string | null;
  /** Número da última requisição de sugestão disparada neste canal. */
  reqSeq: number;
}

export type CategoryGuardState = Record<CategoryChannel, ChannelGuard>;

const CHANNELS: CategoryChannel[] = ["ml", "shopee", "magalu", "olx", "fb"];

function fresh(): ChannelGuard {
  return { origin: "empty", lastAutoValue: null, reqSeq: 0 };
}

export function createCategoryGuard(): CategoryGuardState {
  return Object.fromEntries(CHANNELS.map((c) => [c, fresh()])) as Record<
    CategoryChannel,
    ChannelGuard
  >;
}

const norm = (v: unknown): string =>
  typeof v === "string" ? v.trim().toLowerCase() : "";

/** Forma de comparação dos ids de categoria (a mesma do guard). */
export const normalizeCategoryId = norm;

/**
 * Reset do modal (abrir de novo / fechar). O contador AVANÇA: resposta de uma
 * requisição disparada antes do reset é descartada quando chegar.
 */
export function resetCategoryGuard(state: CategoryGuardState): void {
  for (const c of CHANNELS) {
    state[c] = { ...fresh(), reqSeq: (state[c]?.reqSeq ?? 0) + 1 };
  }
}

/** A pessoa escolheu (picker, rascunho restaurado, "usar sugestão"). */
export function markManual(
  state: CategoryGuardState,
  channel: CategoryChannel,
): void {
  state[channel].origin = "manual";
}

/** A sugestão automática aplicou `value`. */
export function markAuto(
  state: CategoryGuardState,
  channel: CategoryChannel,
  value: string,
): void {
  state[channel].origin = "auto";
  state[channel].lastAutoValue = value;
}

/**
 * Categoria que VOLTA para o formulário: "Continuar" do rascunho ou "Usar
 * último"/"Usar este" do histórico. É escolha da pessoa só quando a origem
 * gravada diz "manual" — e só o rascunho grava a origem, porque é o MESMO
 * cadastro. O histórico traz a categoria de OUTRO produto: entra como sugestão
 * (a sugestão do título novo pode trocá-la), como antes do #359.
 *
 * Hotfix de 23/09/2026: travar tudo o que voltava fazia o "Usar último" grudar
 * a categoria da peça anterior em toda a série (pedal de freio, console e
 * mangueira do ar em "Acessórios", publicados assim no ML) e gravar
 * `mlCategorySource="manual"` em cadastro que ninguém escolheu.
 *
 * Devolve o que marcou; `null` = campo vazio (nada muda).
 */
export function markRestoredCategory(
  state: CategoryGuardState,
  channel: CategoryChannel,
  value: unknown,
  recordedOrigin?: unknown,
): "manual" | "auto" | null {
  if (!norm(value)) return null;
  if (recordedOrigin === "manual") {
    markManual(state, channel);
    return "manual";
  }
  markAuto(state, channel, String(value));
  return "auto";
}

/**
 * Origens a gravar no rascunho: só as escolhas manuais. Na volta, o que não
 * estiver aqui entra como sugestão (ver `markRestoredCategory`).
 */
export function manualCategoryOrigins(
  state: CategoryGuardState,
): Partial<Record<CategoryChannel, "manual">> {
  const out: Partial<Record<CategoryChannel, "manual">> = {};
  for (const c of CHANNELS) {
    if (state[c].origin === "manual") out[c] = "manual";
  }
  return out;
}

/** A sugestão automática limpou o campo (título deixou de indicar categoria). */
export function markEmpty(
  state: CategoryGuardState,
  channel: CategoryChannel,
): void {
  if (state[channel].origin === "manual") return;
  state[channel].origin = "empty";
  state[channel].lastAutoValue = null;
}

/** Nova requisição de sugestão: devolve o número dela. */
export function beginSuggestionRequest(
  state: CategoryGuardState,
  channel: CategoryChannel,
): number {
  state[channel].reqSeq += 1;
  return state[channel].reqSeq;
}

/**
 * Trava por cima da regra que o modal já tinha ("só sobrescreve o valor que a
 * própria sugestão pôs"): bloqueia quando a pessoa escolheu à mão ou quando a
 * resposta é de uma requisição que não é a última. Usado onde o modal mantém a
 * própria comparação com o valor auto-detectado anterior.
 */
export function blocksAutoCategory(
  state: CategoryGuardState,
  channel: CategoryChannel,
  responseSeq?: number,
): boolean {
  const g = state[channel];
  if (g.origin === "manual") return true;
  return responseSeq !== undefined && responseSeq !== g.reqSeq;
}

export function isManualCategory(
  state: CategoryGuardState,
  channel: CategoryChannel,
): boolean {
  return state[channel].origin === "manual";
}

/**
 * Pode a sugestão automática gravar neste canal agora?
 *
 * - escolha manual ⇒ nunca;
 * - resposta de requisição que não é a última ⇒ não (chegou atrasada);
 * - campo vazio ⇒ sim;
 * - campo com valor ⇒ só se for o que a PRÓPRIA sugestão pôs da última vez
 *   (qualquer outro valor veio de outro caminho: catálogo, histórico…).
 */
export function mayApplyAutoCategory(
  state: CategoryGuardState,
  channel: CategoryChannel,
  args: { current: unknown; responseSeq?: number },
): boolean {
  const g = state[channel];
  if (g.origin === "manual") return false;
  if (args.responseSeq !== undefined && args.responseSeq !== g.reqSeq) {
    return false;
  }
  const current = norm(args.current);
  if (!current) return true;
  return g.origin === "auto" && current === norm(g.lastAutoValue);
}

/**
 * O que o efeito de medidas dos modais pode copiar para o registro de
 * "auto-detectados". Enquanto ninguém escolheu a categoria ML, copia a atual
 * (é o que mantém o rótulo acompanhando o título — comportamento de sempre).
 * Com escolha manual, NÃO copia: copiar fazia a escolha passar por automática
 * e a sugestão seguinte a sobrescrevia (bug de 22/09/2026).
 */
export function categoryPatchForAutoDetected(
  state: CategoryGuardState,
  current: { category?: string | null; mlCategory?: string | null },
  prev: { category?: string; mlCategory?: string } | null | undefined,
): { category?: string; mlCategory?: string } {
  if (state.ml.origin === "manual") return {};
  return {
    category: current.category || prev?.category,
    mlCategory: current.mlCategory || prev?.mlCategory,
  };
}

/**
 * Origem a gravar no produto (`mlCategorySource`…). Mesma semântica de antes
 * ("auto" quando o enviado é o que a sugestão pôs), mas a escolha manual agora
 * é reconhecida mesmo quando coincide com o valor sugerido.
 */
export function resolveCategorySource(
  state: CategoryGuardState,
  channel: CategoryChannel,
  submitted: unknown,
): "auto" | "manual" | undefined {
  if (!norm(submitted)) return undefined;
  const g = state[channel];
  if (g.origin === "manual") return "manual";
  return norm(submitted) === norm(g.lastAutoValue) ? "auto" : "manual";
}

/**
 * O que fazer com o chip "Usar sugestão" da categoria ML quando chega uma
 * resposta de sugestão.
 *
 * - resposta que não é a última pedida ⇒ `keep` (a atrasada não mexe);
 * - ninguém escolheu à mão ⇒ `keep` (sem chip: a sugestão aplica sozinha);
 * - sem sugestão, sugestão igual à escolha, ou já recusada com "Manter minha
 *   escolha" ⇒ `clear` (o chip anterior era de outro título);
 * - sugestão diferente da escolha ⇒ `show`.
 */
export function mlSuggestionChipAction(args: {
  responseIsLatest: boolean;
  manual: boolean;
  suggested: string | null | undefined;
  current: unknown;
  declined: ReadonlySet<string>;
}): "show" | "clear" | "keep" {
  if (!args.responseIsLatest || !args.manual) return "keep";
  const sugerida = norm(args.suggested);
  if (!sugerida) return "clear";
  if (sugerida === norm(args.current)) return "clear";
  if (args.declined.has(sugerida)) return "clear";
  return "show";
}
