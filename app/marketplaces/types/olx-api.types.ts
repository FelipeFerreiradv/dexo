// Tipos da API de autoupload da OLX (envio de anúncios em lote + status).
// VALIDADOS contra os docs oficiais (developers.olx.com.br, 2026-07-15).
//
// Fluxo: PUT /autoupload/import { access_token, ad_list } → { token, ... };
// depois POST /autoupload/import/{token} { access_token } → status async.

/** Operação no ad_list. NÃO existe "update": editar = insert com o mesmo id. */
export type OlxAdOperation = "insert" | "delete";

/** Tipo de vendedor: s=particular, u=profissional/loja. */
export type OlxAdType = "s" | "u";

/**
 * Um anúncio no ad_list do import. `params` é por-categoria (atributos
 * específicos, ex.: marca/modelo/ano de autopeças) — shape varia por categoria.
 */
export interface OlxAd {
  id: string; // 1-19 chars [A-Za-z0-9_{}-]; nossa chave estável (SKU)
  operation: OlxAdOperation;
  category: number; // código INTEIRO da categoria OLX
  Subject: string; // título 2-90
  Body: string; // descrição 2-6000
  Phone: string; // 10-11 dígitos (DDD + número)
  type: OlxAdType;
  price: number; // inteiro, SEM decimais
  zipcode: string; // string numérica
  phone_hidden?: boolean;
  params?: Record<string, unknown> | Array<Record<string, unknown>>;
  images?: string[]; // URLs; máx 20; 1ª = principal
  videos?: string[]; // URLs YouTube; máx 1
}

/** Corpo do PUT /autoupload/import. */
export interface OlxImportRequest {
  access_token: string;
  ad_list: OlxAd[];
}

/**
 * Resposta do PUT /autoupload/import. `statusCode`: 0 ok, -1 erro inesperado,
 * -4 validação falhou (import cancelado), -6 sem permissão (plano profissional).
 * O `token` é usado depois para consultar o status (async).
 */
export interface OlxImportResponse {
  token?: string;
  statusCode: number;
  statusMessage?: string;
  errors?: string[];
}

/** Status por-anúncio na consulta de status. */
export type OlxAdStatus =
  "pending" | "error" | "queued" | "accepted" | "refused";

/** Operação refletida na consulta de status (pode incluir "edit"). */
export type OlxStatusOperation = "insert" | "delete" | "edit";

export interface OlxAdStatusEntry {
  status: OlxAdStatus;
  operation: OlxStatusOperation;
  // list_id: id REAL do anúncio na OLX (só quando accepted). Persistir separado
  // do nosso `id`/SKU (externalListingId).
  list_id?: string;
  url?: string; // permalink público
  message?: string[];
  image_errors?: string[];
}

/**
 * Resposta do POST /autoupload/import/{token}. `autoupload_status` async:
 * "pending" enquanto processa, "done" quando termina — poll até "done".
 * `ads` é keyed pelo nosso `id` (SKU).
 */
export interface OlxImportStatus {
  autoupload_status: "done" | "pending";
  ads: Record<string, OlxAdStatusEntry>;
}
