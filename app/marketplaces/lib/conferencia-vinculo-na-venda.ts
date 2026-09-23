import {
  areTitlesSimilar,
  isOppositeSideOrAxis,
  oppositionReason,
  titleSimilarity,
} from "../../lib/title-similarity";

/**
 * O anuncio que acabou de vender ainda descreve a peca que a Dexo vai baixar?
 *
 * POR QUE EXISTE
 * A baixa resolve o produto pelo vinculo `ProductListing.productId` e nunca
 * olha o titulo: `order.usercase.ts` empurra o produto do vinculo direto para o
 * item do pedido. As duas guardas da casa (`areTitlesSimilar`,
 * `isOppositeSideOrAxis`) so rodam no caminho de fallback por SKU, que nem e
 * alcancado quando existe vinculo.
 *
 * Isso cria um ponto cego: o desmanche reaproveita o anuncio para OUTRA peca
 * quando a primeira vende, e a Dexo continua baixando a peca antiga. Medido em
 * 23/09/2026: 566 anuncios ativos em 2 clientes vendendo peca diferente da que
 * a Dexo baixaria.
 *
 * O titulo remoto ja esta em maos no momento da importacao, entao esta
 * conferencia custa ZERO chamada de rede.
 *
 * ESTE MODULO NAO DECIDE SE BLOQUEIA. Ele diz o que observou; quem escolhe
 * entre registrar e segurar a baixa e quem chama.
 */

export type VeredictoDoVinculo = "CONFERE" | "SEM_TITULO" | "LADO_OPOSTO" | "OUTRA_PECA";

export type ConferenciaDoVinculo = {
  veredicto: VeredictoDoVinculo;
  divergente: boolean;
  semelhanca: number;
  /** Frase curta para o log e para a pendencia. Vazia quando confere. */
  motivo: string;
};

/**
 * Abaixo deste valor o anuncio nao esta falando da mesma peca.
 *
 * Deliberadamente IGUAL ao limiar de agrupamento da casa
 * (`TITLE_GROUP_THRESHOLD`, 0,4) e nao mais apertado: esta conferencia roda no
 * caminho quente da importacao de pedido, e um limiar alto transformaria
 * variacao normal de escrita ("Macaneta" x "Maçaneta Externa") em pendencia
 * para o lojista resolver. O caso que importa - anuncio de outra peca - da
 * semelhanca perto de ZERO, nao perto do limiar.
 */
export const LIMIAR_DE_DIVERGENCIA = 0.4;

const VAZIO: ConferenciaDoVinculo = {
  veredicto: "SEM_TITULO",
  divergente: false,
  semelhanca: 0,
  motivo: "",
};

/**
 * @param tituloRemoto titulo que o anuncio tem AGORA no marketplace
 * @param nomeEsperado `titleOverride` do anuncio, ou o nome do produto vinculado
 */
export function conferirVinculoNaVenda(
  tituloRemoto: string | null | undefined,
  nomeEsperado: string | null | undefined,
): ConferenciaDoVinculo {
  const remoto = (tituloRemoto ?? "").trim();
  const esperado = (nomeEsperado ?? "").trim();
  // Sem um dos dois lados nao ha o que comparar. Silencio aqui e de proposito:
  // acusar divergencia por falta de dado encheria a tela de pendencia falsa.
  if (!remoto || !esperado) return VAZIO;

  const semelhanca = titleSimilarity(remoto, esperado);

  // O lado/eixo oposto vem ANTES do limiar porque `areTitlesSimilar` APROVA
  // peca espelhada: depois da canonizacao de lado/eixo o par "L/e" x "L/d" da
  // 0,78, que passa em qualquer limiar usado na casa
  // (tests/peca-espelhada-lado-eixo.spec.ts). Canonizar tornou o numero
  // honesto, nao o veredito seguro.
  if (isOppositeSideOrAxis(remoto, esperado)) {
    return {
      veredicto: "LADO_OPOSTO",
      divergente: true,
      semelhanca,
      motivo: `o anuncio e a peca vinculada divergem em ${oppositionReason(remoto, esperado)}`,
    };
  }

  if (areTitlesSimilar(remoto, esperado, LIMIAR_DE_DIVERGENCIA)) {
    return { veredicto: "CONFERE", divergente: false, semelhanca, motivo: "" };
  }

  return {
    veredicto: "OUTRA_PECA",
    divergente: true,
    semelhanca,
    motivo: `o anuncio esta vendendo "${remoto}" e a peca vinculada e "${esperado}"`,
  };
}
