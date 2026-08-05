/**
 * Ancoragem do <textarea> invisível de edição do IText — puro (sem fabric),
 * para permitir teste unitário em ambiente node.
 *
 * POR QUE ISTO EXISTE (causa-raiz do "a imagem e o texto somem / ficam
 * dançando" ao dar duplo clique num texto):
 *
 * 1. `_calcTextareaPosition` do fabric devolve a posição do cursor JÁ corrigida
 *    pela escala CSS do canvas, e no fim soma `canvas._offset` — que
 *    `getElementOffset` calcula RELATIVO AO DOCUMENTO. O comentário no fonte do
 *    fabric é literal: "add canvas offset on document".
 * 2. O textarea é criado com `position: absolute` e inserido em
 *    `hiddenTextareaContainer || document.body`. O default (`body`) NÃO é
 *    posicionado, então `absolute` resolve contra o documento e a conta fecha.
 * 3. Mas o `wrapperEl` do fabric é criado com `position: relative` — ancorar o
 *    textarea nele faz o offset do documento ser contado DUAS VEZES. Num dialog
 *    centrado isso joga o textarea ~500px fora da caixa do canvas.
 * 4. Ao entrar em edição o fabric chama `focus()` nesse textarea, e o navegador
 *    rola o ancestral rolável mais próximo para trazê-lo à vista. O wrapper do
 *    canvas é `overflow-hidden` — que É rolável programaticamente. O canvas sai
 *    do enquadramento (= "tudo em branco"), e cada reposicionamento de cursor
 *    repete o salto (= "dançando").
 *
 * A correção é ancorar o textarea num host de tamanho ZERO com
 * `overflow: hidden`, filho do Content do dialog: ele continua DENTRO do
 * focus-trap do Radix (a razão original de ancorar fora do body), mas deixa de
 * conter o canvas — então a única caixa que o navegador pode rolar para trazer
 * o textarea à vista é uma caixa vazia, e o canvas não sai do lugar. O
 * `position: fixed` do host tira o textarea do fluxo e evita que ele estique o
 * scroll de qualquer ancestral.
 *
 * OBS: o host NÃO fica na origem do viewport. O Content do dialog usa
 * `translate-x/-y`, e um `transform` cria bloco de contenção até para
 * descendentes `fixed` — então o host nasce no canto do Content. Isso é
 * irrelevante aqui: o textarea é invisível (`opacity: 0`) e fica clipado; o que
 * importa é ele não estar mais dentro da caixa rolável do canvas. Medido em
 * desktop e em toque, com o texto no canto (pior caso): o scroll do wrapper
 * fica em 0 e o canvas segue 99-100% visível.
 */

/** Só o que `clampScroll` precisa tocar (mantém o módulo livre de lib.dom). */
export interface ScrollableLike {
  scrollLeft: number;
  scrollTop: number;
}

/**
 * Estilo do host do textarea. `fixed` + tamanho zero + `overflow: hidden`:
 * bloco de contenção na origem do viewport, conteúdo clipado, e um scroll box
 * vazio — rolar ele não move nada visível.
 */
export const TEXTAREA_HOST_STYLE = {
  position: "fixed",
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  overflow: "hidden",
} as const;

/**
 * Onde inserir o textarea invisível: o primeiro candidato presente vence, e o
 * `wrapperEl` do fabric é o último recurso — o comportamento anterior,
 * byte-idêntico, para não quebrar chamador que não passe o parâmetro novo.
 *
 * Os candidatos são, em ordem: o host passado explicitamente na chamada e o
 * host já memorizado para aquele canvas (caminhos internos como duplicar uma
 * camada de texto não têm como repassar o parâmetro).
 */
export function resolveTextareaHost<T extends object>(
  wrapperEl: T | null | undefined,
  ...candidates: Array<T | null | undefined>
): T | null {
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return wrapperEl ?? null;
}

/**
 * Devolve o wrapper ao enquadramento. Só atua quando já saiu do lugar, então é
 * no-op no caminho feliz — e devolve `true` apenas quando corrigiu de fato.
 */
export function clampScroll(el: ScrollableLike | null | undefined): boolean {
  if (!el) return false;
  if (el.scrollLeft === 0 && el.scrollTop === 0) return false;
  el.scrollLeft = 0;
  el.scrollTop = 0;
  return true;
}
