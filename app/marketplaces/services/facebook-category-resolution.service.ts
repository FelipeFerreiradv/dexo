import {
  FACEBOOK_CATEGORY_MAP,
  FACEBOOK_DEFAULT_CATEGORY,
} from "../facebook/facebook-category-map";
import { FACEBOOK_PART_MAP } from "../facebook/facebook-part-map";

/**
 * Resolve o `google_product_category` de um produto para o catálogo Meta.
 *
 * Espelha olx-category-resolution: puramente OFFLINE (de-para curado + default),
 * sem I/O — testável e utilizável sem credenciais. A Meta não expõe árvore de
 * categoria consultável por API; o google_product_category é o sinal padrão.
 *
 * Ordem de confiança:
 *  1. product.fbCategoryId / fbCategory / googleProductCategory — vence.
 *     (`fbCategoryId` é a coluna de memória, no padrão mlCategoryId; os outros
 *     dois nomes são aceitos por compatibilidade com chamadores existentes.)
 *  2. DE-PARA de VEÍCULO por palavra no nome (facebook-category-map).
 *  3. DE-PARA de TIPO DE PEÇA (facebook-part-map) — as 21 cestas por sistema.
 *  4. FACEBOOK_DEFAULT_CATEGORY (Motor Vehicle Parts — o grosso da Jotabê).
 *
 * ⚠️ VEÍCULO ANTES DE PEÇA, e a ordem não é estética. "Farol de Moto" é peça de
 * MOTO; se os dois de-paras fossem consultados juntos, a regra de "chave mais
 * longa vence" faria `farol`(5) ganhar de `moto`(4) e toda peça de moto mudaria
 * de destino. Com a ordem, o passo 2 decide antes de o passo 3 ser consultado.
 *
 * ⚠️ INVARIANTE DE NÃO-REGRESSÃO: o passo 3 só roda quando o 2 não casou — ou
 * seja, só onde a resolução ANTES caía no default. Nenhum nome que já resolvia
 * para motos ou barcos muda; o que muda é genérico → específico.
 */
export class FacebookCategoryResolutionService {
  static resolveCategory(product: any): string {
    const explicit =
      product?.fbCategoryId ??
      product?.fbCategory ??
      product?.googleProductCategory;
    if (typeof explicit === "string" && explicit.trim()) {
      return explicit.trim();
    }

    // 2. VEÍCULO (moto / barco) — decide antes da peça, ver o cabeçalho.
    const veiculo = this.lookup(product, FACEBOOK_CATEGORY_MAP);
    if (veiculo) return veiculo;

    // 3. TIPO DE PEÇA — só chega aqui o que antes ia direto para o default.
    const peca = this.lookup(product, FACEBOOK_PART_MAP);
    if (peca) return peca;

    return FACEBOOK_DEFAULT_CATEGORY;
  }

  /**
   * Casa a PALAVRA (word-boundary) no nome do produto — a chave mais longa
   * vence. Ex.: "Retrovisor Moto Honda" casa "moto"; "Suporte do Motor Gol" NÃO
   * casa "moto" (o `` impede) e cai no de-para de peça, onde `motor` resolve.
   *
   * A chave mais longa vencer é o que faz as chaves COMPOSTAS desempatarem:
   * "Máquina de Vidro" casa `maquina de vidro`(16) e não `vidro`(5), então vira
   * peça de janela em vez de peça de motor.
   */
  private static lookup(
    product: any,
    mapa: Record<string, string>,
  ): string | null {
    const name = this.normalize(product?.name);
    if (!name) return null;
    let best: { len: number; value: string } | null = null;
    for (const [rawKey, value] of Object.entries(mapa)) {
      const key = this.normalize(rawKey);
      if (!key || !value) continue;
      const re = new RegExp(
        `\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      );
      if (re.test(name)) {
        if (!best || key.length > best.len) best = { len: key.length, value };
      }
    }
    return best?.value ?? null;
  }

  /** minúsculas, sem acento, trim — para casamento de termos. */
  private static normalize(s: unknown): string {
    return String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim();
  }
}
