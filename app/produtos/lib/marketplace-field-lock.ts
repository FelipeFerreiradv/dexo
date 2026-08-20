/**
 * As regras puras da trava dos campos que o marketplace congela na publicação.
 *
 * Moram aqui, fora do componente, por dois motivos. O primeiro é testabilidade:
 * a decisão de travar tem quatro entradas e um caso de borda (a lista de
 * anúncios ainda carregando) que não dá para exercitar de fora. O segundo é que
 * a MESMA decisão é tomada em dois lugares da tela — no campo "Part Number",
 * pelo componente, e no "Código OEM" da ficha técnica, pelo modal — e duas
 * cópias da mesma regra divergem, é só questão de tempo.
 */

export type CanalTravado = "Mercado Livre" | "Shopee";

/** Slug estável para `data-testid` — o nome do canal tem espaço. */
export const SLUG_CANAL: Record<CanalTravado, string> = {
  "Mercado Livre": "ml",
  Shopee: "shopee",
};

/**
 * Os dois campos que o marketplace congela na publicação.
 *
 * `categoria` e `codigo` NÃO são o mesmo dado nem viram o mesmo atributo: a
 * categoria é o `category_id` do anúncio, e o código de peça vira DOIS
 * atributos distintos do ML — `PART_NUMBER`, alimentado por `product.partNumber`,
 * e `OEM`, alimentado pela ficha técnica. O que eles têm em comum é a regra: os
 * três estão congelados depois que o anúncio vai ao ar.
 */
export type CampoTravado = "categoria" | "codigo";

export interface TextoCampoTravado {
  /** Complemento de "O {canal} não aceita ___". */
  naoAceita: string;
  /** Complemento de "os N anúncios ___". */
  continuam: string;
  /** O que acontece com o override por anúncio quando o produto é editado. */
  personalizacao: string;
}

/**
 * Cada campo tem a sua frase porque a concordância muda ("a categoria … ela";
 * "o código … ele"), e aviso mal escrito é aviso que o operador não lê.
 */
export const TEXTO_CAMPO: Record<CampoTravado, TextoCampoTravado> = {
  categoria: {
    naoAceita: "trocar a categoria de um anúncio que já está no ar",
    continuam: "continuam na categoria atual",
    personalizacao:
      "Se algum anúncio tiver categoria personalizada, ela é desfeita",
  },
  codigo: {
    naoAceita: "alterar o código de peça de um anúncio que já está no ar",
    continuam: "continuam com o código atual",
    personalizacao:
      "Se algum anúncio tiver código personalizado, ele é desfeito",
  },
};

/**
 * Trava enquanto a lista de anúncios não respondeu.
 *
 * O inverso — liberar durante o carregamento e travar quando a resposta chega —
 * deixaria uma janela em que o campo parece editável e não é, e é justamente
 * essa impressão que a trava existe para desfazer. O custo de travar cedo é um
 * campo cinza por meio segundo; o de liberar cedo é o operador digitar e perder.
 */
export function precisaTravar(input: {
  carregando: boolean;
  anunciosPublicados: number;
  liberado: boolean;
}): boolean {
  if (input.liberado) return false;
  return input.carregando || input.anunciosPublicados > 0;
}

/**
 * Se o "Código OEM" da ficha técnica entra travado no modo PRODUTO.
 *
 * `emModoAnuncio` é o motivo de esta função existir. Editando um anúncio de
 * Shopee, OLX ou Facebook, o código de peça É aceito — os três reconstroem a
 * ficha ou o anúncio inteiro — e travá-lo ali com a contagem de anúncios do
 * Mercado Livre seria mentira. O modo anúncio do próprio ML não passa por aqui:
 * lá os dois campos ficam em leitura pura, sem escape, porque não há o que
 * liberar.
 */
export function oemTravadoNoProduto(input: {
  emModoAnuncio: boolean;
  liberado: boolean;
  carregando: boolean;
  anunciosPublicadosMl: number;
}): boolean {
  if (input.emModoAnuncio) return false;
  return precisaTravar({
    carregando: input.carregando,
    anunciosPublicados: input.anunciosPublicadosMl,
    liberado: input.liberado,
  });
}
