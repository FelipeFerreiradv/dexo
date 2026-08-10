// Contratos da escrita com confirmação humana. Fase 9.
//
// ⭐ A FRASE QUE GOVERNA ESTE MÓDULO INTEIRO: o agente NÃO ESCREVE. Ele PROPÕE.
//
// Uma tool de escrita não toca no banco de negócio. Ela valida os argumentos,
// resolve o alvo dentro do tenant, monta um resumo do que mudaria e grava uma
// linha em `AiAction` com status "pendente". Quem escreve é o clique do lojista
// em `POST /ai/acoes/:id/confirmar` — e o que é executado sai do `payload`
// daquela linha, nunca do que o navegador devolveu.
//
// Essa separação é o que dá as três garantias da fase:
//   1. nada acontece sem gesto humano, e o gesto é um clique que o SERVIDOR
//      reconhece — não um "sim" que o modelo interpretou;
//   2. o lojista vê campo a campo o que vai mudar, ANTES;
//   3. confirmar duas vezes executa uma vez só (a reivindicação é atômica).

/** As ações que o Bitz pode propor. String livre no banco — ver o schema. */
export type AiAcaoTipo =
  | "produto.criar"
  | "produto.preco"
  | "produto.estoque"
  | "cliente.criar";

export type AiAcaoStatus =
  | "pendente"
  /**
   * ⭐ REIVINDICADA, executando agora. Estado curto e essencial.
   *
   * Sem ele, marcar "confirmada" antes de executar tornaria indistinguíveis
   * "executou e deu certo" e "o processo morreu no meio" (pm2 reload, OOM) — e
   * o segundo pareceria sucesso para sempre. Uma linha presa aqui é um sinal
   * investigável; uma linha "confirmada" que nunca executou é uma mentira
   * silenciosa.
   */
  | "executando"
  | "confirmada"
  | "cancelada"
  | "falhou";

/**
 * ⭐ QUAL PERMISSÃO CADA AÇÃO EXIGE. Declaração ÚNICA, de propósito.
 *
 * Ela é consultada em DOIS momentos distintos, e é aí que mora o risco que esta
 * constante existe para eliminar:
 *
 *   1. quando a tool PROPÕE — o tool-runner lê `tool.action`;
 *   2. quando a rota CONFIRMA — porque entre propor e confirmar o administrador
 *      pode ter tirado a permissão do colaborador, e o que vale é o AGORA.
 *
 * Se cada um declarasse a sua, bastaria alguém acrescentar uma ação e esquecer
 * de um dos lados para existir uma escrita confirmável sem a permissão que a
 * criou. As tools importam daqui (`action: ACAO_EXIGE_PERMISSAO[...]`), então
 * não há dois lugares para manter em sincronia — há um.
 */
export const ACAO_EXIGE_PERMISSAO = {
  "produto.criar": "bitz.criar-produto",
  "produto.preco": "bitz.atualizar-preco",
  "produto.estoque": "bitz.ajustar-estoque",
  "cliente.criar": "bitz.criar-cliente",
} as const satisfies Record<AiAcaoTipo, string>;

/** Uma linha do cartão: o que muda, de quê para quê. */
export interface AiAcaoCampo {
  campo: string;
  /** Ausente em criação — não havia valor antes. */
  de?: string | null;
  para: string;
}

/**
 * O que o CARTÃO mostra. Gravado junto da proposta, e não recalculado na hora
 * de confirmar: o que o lojista viu ao decidir é o que fica registrado, mesmo
 * que o produto mude no meio do caminho.
 */
export interface AiAcaoPreview {
  /** "Cadastrar peça", "Alterar preço". Escrito para o LOJISTA. */
  titulo: string;
  /** Sobre o que a ação é: "Cubo de roda dianteiro (SKU 4821)". */
  alvo?: string;
  campos: AiAcaoCampo[];
  /**
   * ⚠️ A consequência que não cabe numa linha de campo.
   *
   * É aqui que mora o aviso de marketplace: alterar preço ou estoque de uma
   * peça anunciada muda o anúncio no Mercado Livre e na Shopee ASSIM QUE for
   * confirmado, e não há um clique para desfazer. Quem decide precisa saber
   * disso na hora de decidir, não depois.
   */
  aviso?: string;
}

/** O que a UI recebe para desenhar o cartão. NUNCA contém o payload. */
export interface AiAcaoProposta {
  id: string;
  tipo: AiAcaoTipo;
  preview: AiAcaoPreview;
  /** ISO. Proposta velha não executa — ver `PROPOSTA_VALIDA_POR_MS`. */
  expiraEm: string;
}

/**
 * Resultado de confirmar ou cancelar.
 *
 * `jaEstava` distingue "acabei de executar" de "outro clique já tinha
 * executado" — a UI trata os dois como sucesso, e a auditoria não.
 */
export type AiAcaoResultado =
  | {
      ok: true;
      status: "confirmada" | "cancelada";
      resultId: string | null;
      jaEstava: boolean;
    }
  | { ok: false; motivo: AiAcaoFalha; mensagem: string };

export type AiAcaoFalha =
  | "nao_encontrada"
  | "expirada"
  | "ja_decidida"
  /** Outro clique reivindicou e está executando AGORA. Não é erro de ninguém. */
  | "em_andamento"
  | "sem_permissao"
  | "erro_execucao";

/**
 * Por quanto tempo uma proposta continua válida.
 *
 * ⚠️ NÃO É BUROCRACIA. O cartão diz "de R$ 180,00 para R$ 240,00". Se o lojista
 * confirmar isso amanhã, o "de" pode não ser mais R$ 180,00 — outra pessoa
 * mexeu, um sync trouxe outro valor — e ele estaria aprovando uma mudança que
 * não é a que leu. Meia hora cobre pensar, conferir na tela e voltar; um dia
 * não cobre nada disso e só amplia a janela.
 */
export const PROPOSTA_VALIDA_POR_MS = 30 * 60 * 1000;

/** Mensagem que o USUÁRIO lê. Nunca detalhe técnico. */
export function mensagemDeFalhaDeAcao(motivo: AiAcaoFalha): string {
  switch (motivo) {
    case "nao_encontrada":
      return "Não encontrei essa ação. Peça de novo ao Bitz.";
    case "expirada":
      return "Essa proposta passou da validade. Peça de novo ao Bitz para ele conferir os valores atuais.";
    case "ja_decidida":
      return "Essa ação já foi decidida antes.";
    case "em_andamento":
      // ⭐ Distinto de "já decidida" de propósito: quem clicou duas vezes rápido
      // não fez nada errado, e dizer "já foi decidida" o deixaria sem saber se
      // deu certo. Aqui a mensagem manda esperar e conferir.
      return "Essa ação está sendo executada agora. Aguarde um instante e confira na tela.";
    case "sem_permissao":
      return "Você não tem permissão para esta ação. Fale com o administrador da conta.";
    case "erro_execucao":
    default:
      return "Não consegui concluir a ação. Nada foi alterado. Tenta de novo?";
  }
}
