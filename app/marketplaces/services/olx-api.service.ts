import axios from "axios";
import { OLX_CONSTANTS } from "../olx/olx-constants";
import type {
  OlxAd,
  OlxImportRequest,
  OlxImportResponse,
  OlxImportStatus,
} from "../types/olx-api.types";

/**
 * Cliente HTTP do autoupload da OLX (envio de anúncios em lote + status).
 *
 * ⚠️ Difere de ML/Magalu: a OLX NÃO usa `Authorization: Bearer`. O access_token
 * vai no CORPO de cada request (`{ access_token, ... }`). O host é apps.olx.com.br
 * (API_URL), separado do OAuth (auth.olx.com.br).
 *
 * A API é assíncrona em lote: PUT /autoupload/import devolve um `token`; o
 * resultado por-anúncio é consultado depois em POST /autoupload/import/{token}
 * (poll até `autoupload_status === "done"`). Não há "update": editar = insert
 * com o mesmo `id`; despublicar = delete.
 */
export class OlxApiService {
  private static formatError(prefix: string, error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const data: any = error.response?.data;
      const apiMessage =
        data?.statusMessage ||
        data?.message ||
        data?.error ||
        (Array.isArray(data?.errors) ? JSON.stringify(data.errors) : "") ||
        error.message;
      const wrapped = new Error(`${prefix}: ${apiMessage}`);
      (wrapped as any).status = error.response?.status;
      (wrapped as any).responseData = error.response?.data;
      (wrapped as any).cause = error;
      return wrapped;
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Envia um lote de anúncios (PUT /autoupload/import). Retorna o `token` +
   * `statusCode` (0 ok, -1 erro inesperado, -4 validação falhou, -6 sem
   * permissão/plano). O `token` alimenta getImportStatus.
   */
  static async submitImport(
    accessToken: string,
    adList: OlxAd[],
  ): Promise<OlxImportResponse> {
    try {
      const url = new URL(
        OLX_CONSTANTS.AUTOUPLOAD_ENDPOINT,
        OLX_CONSTANTS.API_URL,
      );
      const body: OlxImportRequest = {
        access_token: accessToken,
        ad_list: adList,
      };
      // Guard local do limite de payload (1 MB) antes de gastar egress.
      const size = Buffer.byteLength(JSON.stringify(body), "utf-8");
      if (size > OLX_CONSTANTS.MAX_PAYLOAD_BYTES) {
        throw new Error(
          `Payload OLX excede 1 MB (${size} bytes) — reduza imagens/itens do lote`,
        );
      }

      const response = await axios.put<OlxImportResponse>(
        url.toString(),
        body,
        {
          headers: { "Content-Type": "application/json" },
          timeout: OLX_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      return response.data;
    } catch (error) {
      throw this.formatError("Erro ao enviar import para a OLX", error);
    }
  }

  /**
   * Consulta o status de um import (POST /autoupload/import/{token}).
   * `autoupload_status`: "pending" enquanto processa, "done" ao terminar.
   */
  static async getImportStatus(
    accessToken: string,
    token: string,
  ): Promise<OlxImportStatus> {
    try {
      const response = await axios.post<OlxImportStatus>(
        `${OLX_CONSTANTS.API_URL}${OLX_CONSTANTS.IMPORT_STATUS_ENDPOINT}/${encodeURIComponent(token)}`,
        { access_token: accessToken },
        {
          headers: { "Content-Type": "application/json" },
          timeout: OLX_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      return response.data;
    } catch (error) {
      throw this.formatError(
        "Erro ao consultar status do import na OLX",
        error,
      );
    }
  }

  /**
   * Faz poll do status até `autoupload_status === "done"` (ou esgotar as
   * tentativas). Best-effort: devolve o último status obtido. Não lança em
   * timeout de poll — o chamador decide (o anúncio pode ainda estar na fila da
   * OLX: pending → queued → accepted).
   */
  static async pollImportUntilDone(
    accessToken: string,
    token: string,
    opts?: { intervalMs?: number; maxAttempts?: number },
  ): Promise<OlxImportStatus | null> {
    const interval = opts?.intervalMs ?? OLX_CONSTANTS.IMPORT_POLL_INTERVAL_MS;
    const maxAttempts =
      opts?.maxAttempts ?? OLX_CONSTANTS.IMPORT_POLL_MAX_ATTEMPTS;

    let last: OlxImportStatus | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        last = await this.getImportStatus(accessToken, token);
        if (last?.autoupload_status === "done") {
          return last;
        }
      } catch (err) {
        // transitório: continua tentando até esgotar
        console.warn(
          `[OlxApiService] poll status falhou (tentativa ${attempt + 1}):`,
          err instanceof Error ? err.message : String(err),
        );
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    return last;
  }

  /**
   * Insere/edita UM anúncio (operation "insert"). Editar = insert com o mesmo
   * `id`. Monta um ad_list de 1 item e chama submitImport.
   */
  static async upsertAd(
    accessToken: string,
    ad: Omit<OlxAd, "operation">,
  ): Promise<OlxImportResponse> {
    return this.submitImport(accessToken, [{ ...ad, operation: "insert" }]);
  }

  /**
   * Despublica UM anúncio (operation "delete"). O `id` deve ser o mesmo usado
   * no insert. Só `id` + `operation` são necessários no delete; os demais
   * campos são preenchidos como no-op para satisfazer o shape.
   */
  static async deleteAd(
    accessToken: string,
    id: string,
  ): Promise<OlxImportResponse> {
    return this.submitImport(accessToken, [
      { id, operation: "delete" } as OlxAd,
    ]);
  }
}
