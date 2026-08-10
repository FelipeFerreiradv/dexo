// Tool de ESCRITA da memória da loja. Fase 11.
//
// ⭐ NÃO GRAVA. Valida, monta o cartão e grava uma PROPOSTA; quem ensina é o
// clique do administrador.
//
// Por que uma regra da loja passa pelo mesmo cartão de "cadastrar peça", sendo
// que ela não toca em tabela de negócio nenhuma: porque o alcance é maior, não
// menor. Uma peça errada é uma linha errada, que se corrige na tela. Uma regra
// errada entra no prompt de TODA a equipe, em TODO turno, e passa a torcer as
// respostas de todo mundo até alguém desconfiar e ir apagar. Ler antes de clicar
// é o conserto barato dessa classe de erro.
//
// ⚠️ SÓ O ADMINISTRADOR. `scope.isAdmin`, não `canAction` — a permissão por ação
// nasce LIGADA para o colaborador (default da casa), e "só o dono ensina" é uma
// afirmação mais forte do que ela sabe fazer.

import { z } from "zod";

import { proporAcao } from "../../acoes/acao.service";
import {
  ACAO_EXIGE_PERMISSAO,
  type AiAcaoPreview,
} from "../../acoes/acao.types";
import {
  listarMemorias,
  memoriasParecidas,
} from "../../memoria/memoria.service";
import {
  ehTopico,
  MAX_CONTEUDO_CHARS,
  MAX_MEMORIAS_POR_TENANT,
  MENSAGEM_DE_LOTADA,
  ROTULO_DO_TOPICO,
  TOPICOS_DE_MEMORIA,
  verificarConteudo,
  type AiMemoriaTopico,
} from "../../memoria/memoria.types";
import type { AiTool, AiToolContext } from "../registry";

/** Resposta de negócio: nada a propor, e uma frase para o modelo repassar. */
const semProposta = (instrucao: string) => ({
  acao: null,
  paraOModelo: { proposta: "recusada", instrucao },
});

export const lembrarPreferencia: AiTool = {
  name: "lembrar_preferencia",
  // ⚠️ DUAS COISAS DESTE TEXTO SÃO CONTRATO, NÃO ESTILO — e as duas foram
  // apontadas por travas que já existiam no repositório:
  //
  //  1. "NÃO altera" está aqui porque toda tool de escrita precisa DIZER AO
  //     MODELO que não executa (`ai-tools-registry.spec.ts`). "NÃO grava" era
  //     verdade e não bastava: o contrato enumera os verbos, e a frase que ele
  //     exige é a que impede o modelo de anunciar "pronto, guardei".
  //
  //  2. O exemplo de regra de margem NÃO usa a palavra que nomeia a coluna de
  //     margem do `Product`. `ai-privacy.spec.ts` varre o CÓDIGO das tools
  //     atrás de `costPrice|markup` — comentários ele ignora, por isso este
  //     aqui pode citá-los. A trava existe para pegar um `...produto` distraído
  //     no lugar da projeção; um literal de descrição não é esse defeito, mas
  //     furar a regra por conveniência é como ela deixa de pegar o que importa.
  description:
    "PREPARA uma REGRA da loja para o Bitz lembrar em todas as conversas seguintes. NÃO grava e NÃO altera nada agora: devolve uma proposta que o administrador confirma na tela. " +
    "Use quando ele mandar você lembrar, anotar, guardar ou gravar um jeito de trabalhar dele — a margem que ele usa por padrão, como ele anuncia, o que uma palavra significa na loja dele. " +
    "SÓ REGRA, nunca FATO: preço de uma peça, estoque, saldo e SKU você CONSULTA na hora, e nunca guarda. " +
    "NÃO invente a regra a partir da conversa: só use o que ele disse explicitamente para você lembrar.",
  args: z
    .object({
      conteudo: z
        .string()
        .min(1)
        .max(MAX_CONTEUDO_CHARS)
        .describe(
          "A regra em UMA frase, com as palavras do próprio usuário. Sem SKU, sem quantidade, sem dado de cliente.",
        ),
      topico: z
        .enum(TOPICOS_DE_MEMORIA)
        .describe(
          "preco = margem e desconto; anuncio = marketplace; operacao = rotina da loja; vocabulario = o que uma palavra significa aqui; geral = o resto.",
        ),
    })
    .strict(),
  kind: "write",
  // ⚠️ `dashboard` é a página que todo usuário do sistema tem, e está aqui por
  // honestidade: memória não pertence a nenhuma área do Dexo, e escolher
  // "produtos" ou "financeiro" fingiria um gate que não é o gate. Quem barra
  // aqui é `scope.isAdmin`, logo abaixo — e o administrador sempre passa nos
  // dois de qualquer forma.
  page: "dashboard",
  action: ACAO_EXIGE_PERMISSAO["memoria.criar"],
  // ⚠️ VERBO + MARCADOR DE REGRA, e o piso de dois pontos da seleção é o que
  // torna isso seguro (tools/select.ts). Verbo sozinho é o que quase arrastou
  // esta tool para dentro de turnos de consulta: "me lembra quanto eu vendi
  // ontem" casa `lembr` e nada mais — 1 ponto, fica de fora, que é o certo.
  //
  // Nenhuma chave é substring de outra: `cria`/`criar` e `peca`/`pecas` deram
  // ponto duplo por uma palavra na Fase 10, e isso não se repete aqui.
  keywords: [
    "lembr",
    "anot",
    "guard",
    "grav",
    "decor",
    "ensin",
    "regra",
    "sempre",
    "nunca",
    "padrao",
    "costum",
    "prefir",
    "memoria",
  ],
  sourceLabel: "Memória da loja",
  async handler(args, scope, ctx?: AiToolContext) {
    if (!scope.isAdmin) {
      return semProposta(
        "Diga ao usuário, em uma frase, que ensinar uma regra ao Bitz é do administrador da conta, e que ele pode pedir isso ao administrador. NÃO tente outra ferramenta.",
      );
    }

    const verificado = verificarConteudo(args.conteudo);
    if (!verificado.ok) {
      // ⭐ A MENSAGEM DA RECUSA É A DA GUARDA, e vai inteira ao modelo para ele
      // repassar. Uma recusa genérica ("não posso guardar isso") deixaria o
      // lojista tentando a mesma frase para sempre; a mensagem da guarda diz o
      // que fazer diferente.
      return semProposta(
        `${verificado.mensagem} Repasse isso ao usuário com as suas palavras, e ofereça reescrever a regra sem o dado que não pode ser guardado.`,
      );
    }

    const existentes = await listarMemorias({
      dataOwnerId: scope.dataOwnerId,
    });

    if (existentes.length >= MAX_MEMORIAS_POR_TENANT) {
      return semProposta(
        `${MENSAGEM_DE_LOTADA} Repasse isso ao usuário com as suas palavras.`,
      );
    }

    // ⭐ AVISO, NUNCA BLOQUEIO — mesmo precedente da peça homônima na Fase 10.
    // Substituir sozinho apagaria uma regra que ninguém mandou apagar.
    const parecidas = memoriasParecidas(verificado.conteudo, existentes);

    // `AiTool` entrega `args` como `any` (o zod é a validação de verdade, no
    // tool-runner). Estreitar aqui, com a mesma guarda que a leitura usa, é o
    // que evita um `as` cego: tópico fora do vocabulário fechado cai em "geral"
    // em vez de virar um rótulo `undefined` no cartão.
    const topico: AiMemoriaTopico = ehTopico(args.topico) ? args.topico : "geral";

    const preview: AiAcaoPreview = {
      titulo: "Ensinar uma regra ao Bitz",
      alvo: ROTULO_DO_TOPICO[topico],
      campos: [
        { campo: "Assunto", para: ROTULO_DO_TOPICO[topico] },
        { campo: "Regra", para: verificado.conteudo },
      ],
      aviso: avisoDoCartao(parecidas.map((m) => m.conteudo)),
    };

    const acao = await proporAcao({
      scope,
      tipo: "memoria.criar",
      payload: { topico, conteudo: verificado.conteudo },
      preview,
      conversationId: ctx?.conversationId,
    });

    return {
      acao,
      paraOModelo: {
        proposta: "criada",
        acaoId: acao.id,
        instrucao:
          "Preparei a regra para você lembrar. Diga ao usuário, em UMA frase, qual regra você preparou, e peça para ele CONFERIR E CONFIRMAR no cartão. " +
          "NÃO diga que já guardou e NÃO diga que já vai lembrar: nada foi gravado ainda. " +
          'Se ele responder "sim" por escrito, explique que a confirmação é o botão do cartão.',
      },
    };
  },
};

/**
 * O aviso do cartão.
 *
 * ⭐ A PRIMEIRA FRASE É A MAIS IMPORTANTE DA FASE, e ela nunca falta: o que o
 * administrador ensina o Bitz repete para QUALQUER pessoa da loja, porque a
 * memória entra no prompt de todo turno de todo mundo. Quem escrever "meu markup
 * é 2,2x" precisa saber, na hora de decidir, que o balconista vai poder ouvir
 * isso do Bitz — e não descobrir depois.
 */
function avisoDoCartao(parecidas: string[]): string {
  const base =
    "Esta regra vale para TODA a equipe: o Bitz vai levá-la em conta em qualquer conversa, de qualquer usuário desta loja.";

  if (parecidas.length === 0) return base;

  const lista = parecidas
    .slice(0, 2)
    .map((c) => `«${c}»`)
    .join(" e ");
  return `⚠️ Você já ensinou algo parecido: ${lista}. As duas vão valer juntas — se esta substitui a antiga, apague a antiga depois. ${base}`;
}
