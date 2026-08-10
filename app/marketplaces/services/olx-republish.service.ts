import { OlxApiService } from "./olx-api.service";
import { OlxPayloadBuilderService } from "./olx-payload-builder.service";
import { OlxCategoryResolutionService } from "./olx-category-resolution.service";
import { applyOverridesToProduct } from "./listing-overrides.service";
import { OLX_CONSTANTS } from "../olx/olx-constants";

export interface OlxRepublishInput {
  accessToken: string;
  /** `id` do ad_list — o externalListingId já publicado. Preserva a identidade. */
  olxId: string;
  /** Produto COMPLETO. O caller é responsável por não passar um select enxuto. */
  product: any;
  /** Linha do ProductListing, para os overrides por anúncio. */
  listingOverrides?: any;
  sellerPhone?: string | null;
  sellerZipcode?: string | null;
}

export interface OlxRepublishResult {
  success: boolean;
  error?: string;
  /** true quando a OLX recusou o anúncio na fila de revisão (não é falha de rede). */
  refused?: boolean;
  /** `list_id` real da OLX — só vem quando o poll confirma o aceite. */
  olxListId?: string | null;
  permalink?: string | null;
}

/**
 * Republicação de um anúncio OLX — o núcleo compartilhado.
 *
 * A OLX não tem "pausar": pausar é excluir e reativar é recriar. Isso significa
 * que reativar reenvia o anúncio INTEIRO, e por isso a republicação precisa das
 * mesmas invariantes da publicação original: overrides aplicados, preço e imagem
 * validados, categoria correta e confirmação assíncrona.
 *
 * Este serviço existia duplicado: a versão cuidadosa em `syncOlxProductStock` e
 * uma versão crua no ramo de reativação de `updateListingStatus` — que é
 * justamente a usada pelo cancelamento de pedido. Aqui ele vive uma vez só.
 *
 * Contrato deliberado, para os callers manterem o seu:
 *  - função PURA quanto a persistência: não escreve nada no banco;
 *  - NUNCA lança: toda falha vira `{ success: false, error }`;
 *  - devolve `olxListId`/`permalink` para quem quiser persistir.
 */
export class OlxRepublishService {
  static async republish(
    input: OlxRepublishInput,
  ): Promise<OlxRepublishResult> {
    const { accessToken, olxId, product, listingOverrides } = input;

    if (!accessToken) {
      return { success: false, error: "Conta OLX sem credenciais válidas" };
    }
    if (!olxId) {
      return { success: false, error: "Anúncio OLX sem id externo" };
    }

    try {
      // 1. Overrides do anúncio ANTES de qualquer leitura de preço/título.
      //    Sem isto a republicação devolve o anúncio ao ar com o preço base do
      //    produto, descartando a escada de preço por conta e o título editado.
      const effectiveProduct = listingOverrides
        ? (applyOverridesToProduct(product, listingOverrides) as any)
        : product;

      // 2. Guardas duras. Rodam DEPOIS dos overrides de propósito: um
      //    priceOverride válido sobre um produto de preço zerado é publicável, e
      //    o inverso (override ausente) precisa cair no preço do produto.
      const effPrice = Number(
        typeof effectiveProduct?.price?.toNumber === "function"
          ? effectiveProduct.price.toNumber()
          : effectiveProduct?.price,
      );
      if (!Number.isFinite(effPrice) || effPrice <= 0) {
        return {
          success: false,
          error: "Republicação OLX abortada: produto sem preço válido (> 0).",
        };
      }

      const effImages: string[] = [];
      if (effectiveProduct?.imageUrl) {
        effImages.push(String(effectiveProduct.imageUrl));
      }
      if (Array.isArray(effectiveProduct?.imageUrls)) {
        for (const u of effectiveProduct.imageUrls) {
          if (u) effImages.push(String(u));
        }
      }
      if (effImages.length === 0) {
        return {
          success: false,
          error: "Republicação OLX abortada: produto sem imagem.",
        };
      }

      // 3. Categoria: override por anúncio ganha do de-para automático — é a
      //    correção que o operador fez à mão e que a republicação descartava.
      const overrideCategory = (listingOverrides as any)?.olxCategoryOverride;
      const category =
        (overrideCategory != null && Number.isFinite(Number(overrideCategory))
          ? Number(overrideCategory)
          : null) ??
        OlxCategoryResolutionService.resolveCategoryId(effectiveProduct);

      // 4. Contato do vendedor pela CONTA; env é só fallback (multi-tenant).
      const phone = input.sellerPhone ?? OLX_CONSTANTS.SELLER_PHONE;
      const zipcode = input.sellerZipcode ?? OLX_CONSTANTS.SELLER_ZIPCODE;
      if (category == null || !phone || !zipcode) {
        return {
          success: false,
          error:
            "Republicação OLX requer categoria resolvida + telefone/CEP do vendedor (conta ou OLX_SELLER_PHONE/ZIPCODE).",
        };
      }

      const ad = OlxPayloadBuilderService.build(effectiveProduct, {
        categoryId: category,
        phone,
        zipcode,
        params: OlxCategoryResolutionService.buildAdParams(
          effectiveProduct,
          category,
        ),
      });
      // Mesmo id do anúncio já publicado: é isso que faz a OLX tratar como
      // edição em vez de criar um anúncio novo (duplicata).
      ad.id = olxId;

      const resp = await OlxApiService.submitImport(accessToken, [ad]);
      if (resp.statusCode !== 0) {
        const detail =
          resp.statusMessage ||
          (resp.errors && resp.errors.join("; ")) ||
          `statusCode ${resp.statusCode}`;
        return { success: false, error: `OLX recusou a republicação: ${detail}` };
      }

      // 5. Confirmação assíncrona. A OLX responde 200 com o lote aceito; a
      //    validação POR ANÚNCIO só aparece no poll. Sem esta etapa o Dexo grava
      //    "ativo" para um anúncio que a OLX recusou.
      let olxListId: string | null = null;
      let permalink: string | null = null;
      if (resp.token) {
        const status = await OlxApiService.pollImportUntilDone(
          accessToken,
          resp.token,
        );
        const entry = status?.ads?.[ad.id];
        if (entry?.status === "refused") {
          const msg = (entry.message || []).join("; ") || "REFUSED_GENERIC";
          return {
            success: false,
            refused: true,
            error: `OLX recusou o anúncio ao republicar: ${msg}`,
          };
        }
        // Poll inconclusivo devolve null: o caller NÃO deve zerar o que já
        // tinha capturado (ver guarda anti-null em ListingRepository).
        olxListId = entry?.list_id ?? null;
        permalink = entry?.url ?? null;
      }

      return { success: true, olxListId, permalink };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Erro desconhecido ao republicar na OLX",
      };
    }
  }
}
