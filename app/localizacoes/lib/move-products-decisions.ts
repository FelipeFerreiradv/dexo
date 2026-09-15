/**
 * Decisões do diálogo "Mover Produtos", extraídas da tela.
 *
 * Vive em módulo puro porque a suíte deste repo não tem `@testing-library/react`
 * e o jsdom está quebrado no ambiente — a decisão só é testável fora do
 * componente. Mesmo padrão de `app/produtos/lib/location-scan-decision.ts`.
 *
 * O QUE ISTO PROTEGE (chamado MK2, 09/2026): o diálogo abria com
 * "Sem localização (desvincular)" já selecionado e o botão de confirmar só
 * checava `isMoving`. Quem abrisse e clicasse sem mexer no seletor desvinculava
 * as peças — e recebia um toast VERDE de sucesso. A peça sumia da tela de
 * Localizações sem deixar rastro de para onde tinha ido.
 */

export type StatusOpcoes = "idle" | "loading" | "ready" | "error";

export interface EstadoDialogoMover {
  /** id da localização de destino; `null` = nada escolhido. */
  targetLocationId: string | null;
  /** quantas peças estão selecionadas na gaveta. */
  selectedCount: number;
  /** requisição de mover em voo. */
  isMoving: boolean;
  /** estado do carregamento da lista de localizações. */
  optionsStatus: StatusOpcoes;
}

/**
 * Invariante central: confirmar só é possível com um destino ESCOLHIDO.
 *
 * Enquanto as opções carregam a lista está vazia, então nenhum id pode ter sido
 * escolhido e o botão já cai aqui — o estado de carregamento existe para ser
 * honesto com o usuário, não para travar o botão.
 */
export function canConfirmMove(estado: EstadoDialogoMover): boolean {
  if (estado.isMoving) return false;
  if (estado.selectedCount <= 0) return false;
  if (estado.optionsStatus !== "ready") return false;
  return typeof estado.targetLocationId === "string" && estado.targetLocationId.length > 0;
}

/** Texto curto explicando por que o botão está desabilitado. `null` = liberado. */
export function describeMoveBlocker(estado: EstadoDialogoMover): string | null {
  if (estado.isMoving) return null;
  if (estado.selectedCount <= 0) return "Selecione ao menos uma peça.";
  if (estado.optionsStatus === "loading" || estado.optionsStatus === "idle") {
    return "Carregando as localizações...";
  }
  if (estado.optionsStatus === "error") {
    return "Não foi possível carregar as localizações. Tente de novo.";
  }
  if (!estado.targetLocationId) return "Escolha a localização de destino.";
  return null;
}

export interface TextoConfirmacao {
  title: string;
  description: string;
  confirmLabel: string;
}

/**
 * Texto da confirmação de DESVINCULAR. Precisa dizer, em palavras, que a peça
 * fica SEM localização e some da tela de Localizações — é a diferença entre uma
 * ação deliberada e a que gerou este chamado.
 */
export function describeUnbindConfirm(entrada: {
  count: number;
  productName?: string;
  locationCode?: string;
}): TextoConfirmacao {
  const { count, productName, locationCode } = entrada;
  const individual = count === 1 && !!productName;
  const alvo = individual
    ? `a peça "${productName}"`
    : `${count} peça(s) selecionada(s)`;
  const origem = locationCode ? ` de "${locationCode}"` : "";

  return {
    title: individual ? "Desvincular esta peça?" : `Desvincular ${count} peça(s)?`,
    description:
      `Você vai remover ${alvo}${origem}. ` +
      "A peça ficará SEM localização e deixará de aparecer na tela de Localizações — " +
      "só será encontrada pela busca na tela de Produtos. " +
      "Para mandar a peça para outra caixa, use o botão Mover.",
    confirmLabel: "Sim, desvincular",
  };
}

export interface ResultadoMovimentacao {
  /** ids enviados na requisição. */
  requested: number;
  /** `count` devolvido pelo servidor (contrato antigo). */
  count: number;
  /** campos novos e OPCIONAIS — ausentes quando o servidor não os enviou. */
  moved?: number;
  alreadyThere?: number;
  notFound?: number;
  /** caminho do destino; `null` quando foi desvínculo. */
  targetLabel: string | null;
  /** mensagem montada pelo servidor. */
  serverMessage?: string;
}

/**
 * Traduz a resposta em mensagem + TOM.
 *
 * Antes, a tela fazia `showToast(result.message, "success")` sem olhar número
 * nenhum: `count === 0` virava "0 produto(s) movido(s) para X" em VERDE, o que
 * torna um no-op indistinguível de um sucesso.
 *
 * `moved` (quando presente) é mais honesto que `count`: o `updateMany` do
 * repositório não filtra pela origem, então peça que JÁ estava no destino entra
 * no `count` sem ter se movido.
 */
export function describeMoveOutcome(r: ResultadoMovimentacao): {
  message: string;
  tone: "success" | "warning";
} {
  const efetivo = typeof r.moved === "number" ? r.moved : r.count;
  const destino = r.targetLabel ? `para "${r.targetLabel}"` : "";
  const acao = r.targetLabel ? "movida(s)" : "desvinculada(s)";

  if (efetivo <= 0) {
    return {
      tone: "warning",
      message: r.targetLabel
        ? `Nenhuma peça foi movida ${destino}. Verifique a seleção e tente de novo.`
        : "Nenhuma peça foi desvinculada. Verifique a seleção e tente de novo.",
    };
  }

  if (efetivo < r.requested) {
    const restantes = r.requested - efetivo;
    const porque =
      typeof r.alreadyThere === "number" && r.alreadyThere > 0
        ? ` (${r.alreadyThere} já estava(m) no destino)`
        : "";
    return {
      tone: "warning",
      message:
        `${efetivo} de ${r.requested} peça(s) ${acao} ${destino}`.trim() +
        `. ${restantes} não mudou de lugar${porque}.`,
    };
  }

  // Caminho feliz: preserva a mensagem do servidor, que já nomeia o destino.
  return {
    tone: "success",
    message: r.serverMessage ?? `${efetivo} peça(s) ${acao} ${destino}`.trim(),
  };
}
