/**
 * LADO E EIXO — ponte para a implementacao da APLICACAO.
 * ======================================================
 *
 * ⚠️ NAO REIMPLEMENTAR AQUI. A regra canonica mora em
 * `app/lib/title-similarity.ts`, que e quem a aplicacao usa de verdade:
 * `listing-autodetect.usercase.ts` (vinculo do anuncio) e `order.usercase.ts`
 * (baixa de estoque). Este arquivo existe so para os scripts de manutencao
 * continuarem falando o vocabulario deles.
 *
 * POR QUE A PONTE, e nao duas copias:
 * durante uma unica sessao a MESMA falha teve de ser corrigida DUAS vezes —
 * a regex aceitava separador opcional e casava com a preposicao "de", entao
 * `ladoDe("Ponta De Eixo Traseiro")` devolvia "E". Consertei na aplicacao e
 * quase esqueci da copia daqui; foi o que motivou unificar. Com duas
 * implementacoes, a proxima divergencia e questao de tempo — e ela nao aparece
 * em teste, aparece em catalogo de cliente.
 *
 * O CUSTO DA DIVERGENCIA, medido: a copia com defeito inflou a contagem de
 * vinculos com lado oposto de 648 para 879, e levou a desfazer 1 fusao de 609
 * que estava correta ("Suporte Direito Flexivel Freio Gol G6" x "Mangueira
 * Flexivel DE Freio Gol G5 G6").
 *
 * Os nomes em portugues sao mantidos porque sao os que os scripts ja usam —
 * trocar 6 arquivos de chamada nao acrescentaria nada.
 */
export {
  titleSide as ladoDe,
  titleAxis as eixoDe,
  isOppositeSideOrAxis as ladoOuEixoOposto,
  oppositionReason as motivoOposicao,
} from "../../app/lib/title-similarity";

export type { TitleSide as Lado, TitleAxis as Eixo } from "../../app/lib/title-similarity";
