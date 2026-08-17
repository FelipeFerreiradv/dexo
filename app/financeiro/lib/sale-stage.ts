// BLOCO F — estágio operacional da venda.
//
// SEGUNDA DIMENSÃO, ortogonal ao status financeiro. Uma venda pode estar PAGA
// e ainda "em separação"; pode estar PENDENTE e já embalada. Misturar as duas
// coisas num enum só é o erro que o `BudgetStage` (schema:907-916) já evitou, e
// este módulo copia o desenho dele:
//
//   · ADITIVA e NULÁVEL — venda antiga fica NULL e DERIVA para o primeiro
//     estágio em read-time. Nenhum backfill, nenhum default destrutivo.
//   · NUNCA GOVERNA. Não impede receber, estornar, editar nem emitir nota.
//     Decisão de 14/08: é informação, não trava. Uma trava operacional no
//     caminho que baixa estoque é exatamente o que ninguém consegue destravar
//     num sábado de movimento.
//
// ⚠️⚠️ OS 11 ESTÁGIOS ABAIXO SÃO PROPOSTA MINHA, NÃO O VOCABULÁRIO DO CLIENTE.
// A lista pedida no prompt original se perdeu, e inventar nome de processo de
// outra pessoa é pior do que perguntar. Estão aqui para a infraestrutura ficar
// pronta e testada; TROCAR CADA NOME É EDITAR UMA LINHA, sem migração — foi
// justamente por isso que a coluna é TEXT. A flag nasce desligada, então nada
// disso aparece em produção antes de você confirmar.
//
// Módulo PURO (sem I/O): serve ao backend e ao bundle.

export interface SaleStageDef {
  /** Código estável gravado na coluna. Rótulo pode mudar sem migração. */
  code: string;
  label: string;
  /** Texto curto de apoio na tela. */
  hint?: string;
}

/** ⚠️ PROPOSTA — aguardando confirmação do vocabulário real. */
export const SALE_STAGES: SaleStageDef[] = [
  { code: "AGUARDANDO_PAGAMENTO", label: "Aguardando pagamento" },
  { code: "PAGAMENTO_CONFIRMADO", label: "Pagamento confirmado" },
  {
    code: "SEPARACAO",
    label: "Em separação",
    hint: "Buscando a peça no pátio",
  },
  { code: "PECA_LOCALIZADA", label: "Peça localizada" },
  { code: "LIMPEZA", label: "Limpeza e preparação" },
  { code: "TESTE", label: "Teste da peça" },
  { code: "CONFERENCIA", label: "Conferência final" },
  { code: "EMBALAGEM", label: "Embalagem" },
  { code: "AGUARDANDO_RETIRADA", label: "Aguardando retirada" },
  { code: "EM_TRANSPORTE", label: "Em transporte" },
  { code: "ENTREGUE", label: "Entregue" },
];

// Protótipo NULO: com objeto literal comum, um `saleStage` vindo do banco
// valendo "toString" devolveria uma FUNÇÃO em vez de cair no fallback, e o
// React estouraria ao renderizá-la. A coluna é TEXT livre — tratar valor
// inesperado é obrigação daqui.
const POR_CODIGO: Record<string, SaleStageDef> = Object.assign(
  Object.create(null),
  Object.fromEntries(SALE_STAGES.map((s) => [s.code, s])),
);

/** O primeiro estágio — é para ele que venda antiga (NULL) deriva. */
export const FIRST_SALE_STAGE = SALE_STAGES[0].code;

/**
 * Flag de BACKEND. Ausente ⇒ nada é gravado na coluna nova e o `data` dos
 * UPDATE fica byte-idêntico. É o que torna seguro subir o código antes de
 * ligar o recurso.
 */
export function isSaleStageEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SALE_STAGE_ENABLED === "1";
}

// Referência literal a process.env.NEXT_PUBLIC_* para o Next inlinar.
const SALE_STAGE_UI_ENABLED =
  process.env.NEXT_PUBLIC_SALE_STAGE_ENABLED === "true";

/** Coluna e seletor de estágio visíveis? Exige `npm run build`. */
export function isSaleStageUiEnabled(): boolean {
  return SALE_STAGE_UI_ENABLED;
}

/**
 * O estágio EFETIVO de uma venda.
 *
 * Derivação em read-time, igual ao `VENCIDA` do Receivable e ao "Novo" do
 * BudgetStage: NULL não é "sem estágio", é "está no começo". Sem isso, toda
 * venda anterior ao recurso apareceria fora do painel — o que faria o painel
 * mentir sobre o movimento da loja.
 *
 * Código DESCONHECIDO (estágio removido do vocabulário depois de já ter sido
 * gravado) é devolvido COMO ESTÁ, não derivado: perder a informação seria pior
 * que exibir um código cru, e é o que permite renomear sem apagar histórico.
 */
export function deriveSaleStage(saleStage: string | null | undefined): string {
  const bruto = saleStage?.trim();
  return bruto ? bruto : FIRST_SALE_STAGE;
}

/** Rótulo de exibição. Código desconhecido volta cru — nunca vira "—". */
export function saleStageLabel(code: string | null | undefined): string {
  const efetivo = deriveSaleStage(code);
  return POR_CODIGO[efetivo]?.label ?? efetivo;
}

/** Posição no pipeline (0-based). `-1` para código fora do vocabulário. */
export function saleStageIndex(code: string | null | undefined): number {
  const efetivo = deriveSaleStage(code);
  return SALE_STAGES.findIndex((s) => s.code === efetivo);
}

/**
 * O próximo estágio, para o botão "avançar" de um clique.
 *
 * `null` no último (e em código desconhecido, onde não há "próximo" que faça
 * sentido) — quem chama esconde o botão em vez de oferecer um passo inválido.
 */
export function nextSaleStage(code: string | null | undefined): string | null {
  const i = saleStageIndex(code);
  if (i < 0 || i >= SALE_STAGES.length - 1) return null;
  return SALE_STAGES[i + 1].code;
}

/**
 * Fronteira de tipo do PATCH: o body é `any`.
 *
 * Só código do vocabulário passa — gravar lixo numa coluna de onde sai painel
 * transformaria uma coluna do quadro em "outros". `undefined` quando não dá
 * para aceitar, e quem chama responde 400: ao contrário do motivo de
 * cancelamento (acessório de uma operação que precisa acontecer), aqui o
 * estágio É a operação, então recusar é a resposta certa.
 */
export function normalizeSaleStage(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!isSaleStageEnabled(env)) return undefined;
  if (typeof value !== "string") return undefined;
  const limpo = value.trim();
  if (!limpo) return undefined;
  return limpo in POR_CODIGO ? limpo : undefined;
}
