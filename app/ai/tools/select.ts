// Qual subconjunto de tools é oferecido ao modelo NESTE turno.
//
// Por que não oferecer todas: a definição de cada tool (nome + descrição +
// schema) custa tokens de ENTRADA em toda mensagem, e o tráfego do Bitz é
// ~15:1 a favor da entrada. Vinte tools em todo turno seriam ~1.200 tokens
// pagos por mensagem, inclusive num "quanto vendi ontem?" que usa uma.
//
// Também melhora a escolha: um cardápio de seis opções relevantes gera menos
// chamada errada que um de vinte, metade delas fora de assunto.
//
// A seleção é POR PALAVRA-CHAVE, determinística e sem custo. Ela nunca é a
// última palavra sobre segurança — quem barra o acesso é `scope.can()` dentro
// do tool-runner. Aqui é só economia.

import { normalizeTerm } from "../../repositories/product-search-terms";
import type { AiTool } from "./registry";

// ⚠️ PALAVRA-CHAVE DE DUAS PALAVRAS É FRÁGIL, e falha em silêncio.
//
// A comparação é substring sobre a frase inteira, então QUALQUER palavra
// intercalada quebra o casamento — e o turno cai no conjunto padrão sem
// ninguém perceber. Aconteceu com a pergunta mais comum do sistema: a chave
// era "quanto vendi", o lojista escreve "quanto EU vendi", e o relatório de
// vendas nunca era oferecido.
//
// Regra: quando a chave for `interrogativo + verbo` ("quanto vendi", "quanto
// cobrar"), use SÓ O VERBO. `interrogativo + substantivo` ("quantos produtos")
// é seguro, porque em português o pronome vem depois, não no meio.
//
// `tests/ai-tools-registry.spec.ts` pina as frases reais.

/** Teto de tools por turno. */
export const MAX_TOOLS_PER_TURN = 8;

/**
 * O que vai quando nada casa.
 *
 * "Me mostra o que tá pegando" não tem palavra-chave, mas é uma pergunta
 * legítima. Estas quatro cobrem o grosso do que se pergunta sem contexto:
 * achar uma peça, achar uma venda, ver o caixa e ver o que está quebrado.
 */
export const TOOLS_PADRAO = [
  "buscar_produto",
  "buscar_pedido",
  "contas_a_receber",
  "diagnostico_operacional",
];

/**
 * Pontua e devolve o subconjunto, em ordem estável.
 *
 * Empate resolvido pela ordem do registry (que é a ordem de declaração), e não
 * por `Array.sort` instável: dois turnos com a mesma pergunta têm de oferecer o
 * mesmo cardápio, senão o comportamento vira sorteio e o teste vira flaky.
 */
export function selectTools(
  message: string,
  registry: Map<string, AiTool>,
  opts?: { max?: number; kinds?: Array<AiTool["kind"]> },
): AiTool[] {
  const max = opts?.max ?? MAX_TOOLS_PER_TURN;
  const kinds = opts?.kinds;

  const candidatas = Array.from(registry.values()).filter(
    (t) => !kinds || kinds.includes(t.kind),
  );

  const texto = ` ${normalizeTerm(message ?? "")} `;

  const pontuadas = candidatas.map((tool, ordem) => {
    let pontos = 0;
    for (const kw of tool.keywords) {
      // Casa como SUBSTRING de propósito: "anuncio" tem de casar "anuncios",
      // e "receb" tem de casar "receber"/"recebimento"/"recebi". As chaves são
      // escolhidas curtas o bastante para isso ser um recurso, não um acidente.
      if (texto.includes(kw)) pontos++;
    }
    return { tool, pontos, ordem };
  });

  const comPonto = pontuadas
    .filter((p) => p.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos || a.ordem - b.ordem)
    .map((p) => p.tool);

  if (comPonto.length > 0) return comPonto.slice(0, max);

  const padrao = TOOLS_PADRAO.map((n) => registry.get(n)).filter(
    (t): t is AiTool => Boolean(t) && (!kinds || kinds.includes(t!.kind)),
  );
  return padrao.slice(0, max);
}
