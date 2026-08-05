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
 * A correção é ancorar o textarea num host `position: fixed` de tamanho ZERO:
 * ele continua DENTRO do focus-trap do Radix (a razão original de ancorar fora
 * do body), mas o bloco de contenção passa a ser a origem do viewport — que é o
 * mesmo referencial de `_offset` dentro de um dialog `fixed` — e a única caixa
 * que o navegador pode rolar é uma caixa vazia que não contém o canvas.
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
