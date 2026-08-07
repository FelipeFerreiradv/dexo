// Classificador de intenção do turno.
//
// HEURÍSTICA, não modelo. Uma chamada extra ao provedor só para decidir se vale
// buscar conhecimento dobraria a latência e o custo de todo turno para resolver
// uma pergunta que palavra-chave responde bem. Também é determinístico, o que
// torna o comportamento testável sem rede.
//
// Fase 4 usa daqui só o `needsRag`. A Fase 5 acrescenta o subconjunto de tools
// no mesmo objeto — por isso `AiIntent` já nasce como registro, e não como
// booleano solto.

import { normalizeTerm } from "../../repositories/product-search-terms";

/**
 * - `duvida`: "como faço X", "por que meu anúncio caiu" → precisa da base.
 * - `dados`: "quanto vendi em julho" → precisa de tool (Fase 5), não da base.
 * - `conversa`: cumprimento, agradecimento, "beleza" → nem uma coisa nem outra.
 */
export type AiIntentKind = "duvida" | "dados" | "conversa";

export interface AiIntent {
  kind: AiIntentKind;
  needsRag: boolean;
}

// Os padrões abaixo casam contra o texto JÁ NORMALIZADO por `normalizeTerm`
// (sem acento, minúsculo) — a mesma normalização da busca de peças. Sem isso,
// "Olá!" não casaria com `ola` e o Bitz iria buscar conhecimento para responder
// a um bom-dia. Uma régua de normalização só no sistema inteiro.

/** Frase inteira é só saudação/agradecimento/confirmação. */
const SO_CONVERSA =
  /^(oi+|ola|opa|eai|e ai|bom dia|boa tarde|boa noite|tudo bem|blz|beleza|valeu|vlw|obrigad[oa]|brigad[oa]|ok|okay|certo|entendi|show|perfeito|legal|top|tchau|ate mais|falou)[\s!.,?]*$/;

/**
 * Pedido de NÚMERO do próprio negócio. O que caracteriza é o verbo/substantivo
 * de medição junto de um recorte de tempo ou de uma entidade contável.
 */
const PEDE_DADOS =
  /\b(quanto|quantos|quantas|total|totais|somatorio|faturamento|faturei|vendi|vendas do|receita|lucro|media|relatorio|resumo do mes|balanco|extrato|listar?|liste|me mostra|mostra ai|top \d|ranking|mais vendid[oa]s|estoque baixo|a receber|a pagar|vencid[oa]s|em aberto)\b/;

/**
 * Pergunta sobre COMO O SISTEMA FUNCIONA. Inclui o vocabulário de erro, que na
 * prática é o caso mais comum de dúvida ("deu erro ao publicar").
 */
const PEDE_AJUDA =
  /\b(como|onde|o que e|oque|pra que serve|para que serve|serve pra|funciona|configur|habilit|ativar|desativar|cadastr|public|emit|imprim|gerar?|integr|conect|vincul|sincroniz|erro|falhou|falha|deu ruim|nao consigo|nao vai|nao aparece|nao funciona|travou|bloqueado|recusad|rejeit|pausad|por que|porque|pq)\b/;

/**
 * Decide a intenção de uma mensagem.
 *
 * O default é `duvida` (com RAG ligado), e não `conversa`. É uma assimetria
 * escolhida: um falso positivo custa ~2.000 tokens de entrada num turno; um
 * falso negativo custa uma resposta errada sobre o sistema, que é o pior
 * defeito que este agente pode ter. Na dúvida, busca.
 */
export function classifyIntent(message: string): AiIntent {
  const texto = normalizeTerm(message ?? "");

  if (!texto || SO_CONVERSA.test(texto)) {
    return { kind: "conversa", needsRag: false };
  }

  // Pedido de número vence, EXCETO quando a frase também pergunta como fazer
  // ("como eu vejo quanto vendi?" é dúvida de operação, não relatório).
  if (PEDE_DADOS.test(texto) && !PEDE_AJUDA.test(texto)) {
    return { kind: "dados", needsRag: false };
  }

  return { kind: "duvida", needsRag: true };
}
