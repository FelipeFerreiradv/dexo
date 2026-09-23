/**
 * Decisoes puras da auditoria de fusao de catalogo. Fica separado dos scripts
 * porque eles falam com o banco de PRODUCAO ao serem carregados: importar o
 * script para testar a regra dispararia a auditoria inteira. Aqui nao ha I/O,
 * entao o teste exercita exatamente o criterio que gerou os numeros do relatorio.
 */

export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Reproduz de proposito o descarte de token de 1 caractere que o tokenizador da
 * aplicacao faz. E por causa dele que "L/e" e "L/d" - pecas OPOSTAS - viram o
 * mesmo texto; aqui a gente usa isso para ACHAR quem foi fundido por esse erro.
 */
export function semTokensDeUmCaractere(nome: string): string {
  return normalizar(nome)
    .split(" ")
    .filter((token) => token.length > 1)
    .join(" ");
}

const LADO_ESQUERDO = new Set(["e", "esq", "esquerdo", "esquerda", "le"]);
const LADO_DIREITO = new Set(["d", "dir", "direito", "direita", "ld"]);
const EIXO_DIANTEIRO = new Set(["dianteiro", "dianteira", "diant", "frontal"]);
const EIXO_TRASEIRO = new Set(["traseiro", "traseira", "tras"]);

function temAlgumToken(nome: string, vocabulario: Set<string>): boolean {
  return normalizar(nome)
    .split(" ")
    .some((token) => vocabulario.has(token));
}

/** `null` quando o nome nao diz o lado, ou quando diz os dois (par). */
export function ladoDe(nome: string): "E" | "D" | null {
  const esquerdo = temAlgumToken(nome, LADO_ESQUERDO);
  const direito = temAlgumToken(nome, LADO_DIREITO);
  if (esquerdo === direito) return null;
  return esquerdo ? "E" : "D";
}

export function eixoDe(nome: string): "DIANTEIRO" | "TRASEIRO" | null {
  const dianteiro = temAlgumToken(nome, EIXO_DIANTEIRO);
  const traseiro = temAlgumToken(nome, EIXO_TRASEIRO);
  if (dianteiro === traseiro) return null;
  return dianteiro ? "DIANTEIRO" : "TRASEIRO";
}

/**
 * Token de ate 2 letras fica fora: "de", "do", "1.6" e afins aparecem em quase
 * todo titulo de autopeca e inflariam a semelhanca de pecas sem relacao.
 */
function palavras(texto: string): Set<string> {
  return new Set(normalizar(texto).split(" ").filter((token) => token.length > 2));
}

export function semelhancaDeNomes(primeiro: string, segundo: string): number {
  const esquerda = palavras(primeiro);
  const direita = palavras(segundo);
  if (esquerda.size === 0 || direita.size === 0) return 0;
  let comuns = 0;
  for (const token of esquerda) if (direita.has(token)) comuns += 1;
  return comuns / (esquerda.size + direita.size - comuns);
}

/** Folgado de proposito: a pergunta e "o anuncio fala desta peca?", nao "e a mesma peca?". */
export const SEMELHANCA_MINIMA = 0.5;

export function falaDaMesmaPeca(tituloDoAnuncio: string, nomeDaPeca: string): boolean {
  if (!tituloDoAnuncio || !nomeDaPeca) return true;
  return semelhancaDeNomes(tituloDoAnuncio, nomeDaPeca) >= SEMELHANCA_MINIMA;
}

export type SinaisDoGrupo = {
  colisaoDesteGrupo: boolean;
  colisaoPreexistente: boolean;
  ladoOpostoPorTokenCurto: boolean;
  ladoDivergente: boolean;
  eixoDivergente: boolean;
};

export type Balde = "DESFAZER_SUGERIDO" | "REVISAR" | "OK";

/**
 * Colisao criada pelo proprio grupo e sinal forte; colisao que ja existia antes
 * e passivo do cliente, nao defeito da fusao - por isso ela so leva a REVISAR.
 */
export function decidirBalde(sinais: SinaisDoGrupo): Balde {
  const suspeitaForte =
    sinais.colisaoDesteGrupo ||
    sinais.ladoOpostoPorTokenCurto ||
    sinais.ladoDivergente ||
    sinais.eixoDivergente;
  if (suspeitaForte) return "DESFAZER_SUGERIDO";
  return sinais.colisaoPreexistente ? "REVISAR" : "OK";
}

export type AnuncioConferido = {
  conta: string;
  statusNoMl: string;
  quantidade: number | null;
};

export type VereditoDoMl = "DUPLA_EXPOSICAO_CONFIRMADA" | "ESPELHO_VELHO" | "INCOMPLETO";

/**
 * "No ar de verdade" exige `active` E quantidade acima de zero: anuncio pausado
 * ou zerado nao expoe a peca. Tratar os dois como iguais transformaria espelho
 * local desatualizado em acusacao de peca dupla.
 */
export function anuncioExpoeAPeca(anuncio: AnuncioConferido): boolean {
  return anuncio.statusNoMl === "active" && (anuncio.quantidade ?? 0) > 0;
}

export function contasComDoisNoAr(anuncios: AnuncioConferido[]): number {
  const porConta = new Map<string, number>();
  for (const anuncio of anuncios) {
    if (!anuncioExpoeAPeca(anuncio)) continue;
    porConta.set(anuncio.conta, (porConta.get(anuncio.conta) ?? 0) + 1);
  }
  return [...porConta.values()].filter((quantos) => quantos >= 2).length;
}

/**
 * A confirmacao vence o "incompleto": se ja ha duas exposicoes provadas, o que
 * falta conferir nao muda o desfecho e nao vale gastar chamada.
 */
export function decidirVeredito(anuncios: AnuncioConferido[]): VereditoDoMl {
  if (contasComDoisNoAr(anuncios) > 0) return "DUPLA_EXPOSICAO_CONFIRMADA";
  const naoConferidos = anuncios.filter((anuncio) => anuncio.statusNoMl === "NAO_CONFERIDO").length;
  return naoConferidos > 0 ? "INCOMPLETO" : "ESPELHO_VELHO";
}
