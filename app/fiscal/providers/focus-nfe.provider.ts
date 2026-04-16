/**
 * Implementação do provedor Focus NFe.
 *
 * Focus NFe expõe API REST — não precisa de SOAP nem assinatura de XML local.
 * O provedor recebe JSON, converte, assina, envia ao SEFAZ e retorna o resultado.
 *
 * Docs: https://focusnfe.com.br/doc/
 *
 * Ambientes:
 *  - Homologação: https://homologacao.focusnfe.com.br
 *  - Produção:    https://api.focusnfe.com.br
 */

import type {
  INfeProvider,
  NfeProviderEmitInput,
  NfeProviderEmitResult,
  NfeProviderConsultaResult,
  NfeProviderCancelInput,
  NfeProviderCancelResult,
  NfeProviderInutilizacaoInput,
  NfeProviderInutilizacaoResult,
} from "./nfe-provider.interface";

const FOCUS_HOMOLOG = "https://homologacao.focusnfe.com.br";
const FOCUS_PROD = "https://api.focusnfe.com.br";

function getBaseUrl(ambiente: "homologacao" | "producao"): string {
  return ambiente === "producao" ? FOCUS_PROD : FOCUS_HOMOLOG;
}

function authHeader(token: string): Record<string, string> {
  const encoded = Buffer.from(`${token}:`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    "Content-Type": "application/json",
  };
}

export class FocusNfeProvider implements INfeProvider {
  readonly name = "FOCUS_NFE";

  private ambiente: "homologacao" | "producao";

  constructor(ambiente: "homologacao" | "producao" = "homologacao") {
    this.ambiente = ambiente;
  }

  async emitir(input: NfeProviderEmitInput): Promise<NfeProviderEmitResult> {
    const baseUrl = getBaseUrl(this.ambiente);
    const url = `${baseUrl}/v2/nfe?ref=${encodeURIComponent(input.ref)}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeader(input.token),
        body: JSON.stringify(input.nfeData),
      });

      const body = await res.json();

      if (res.status === 200 || res.status === 201) {
        // Focus returns 200 for sync authorization or 202 for async processing
        return {
          success: true,
          chaveAcesso: body.chave_nfe ?? null,
          protocolo: body.protocolo ?? null,
          dataAutorizacao: body.data_evento
            ? new Date(body.data_evento)
            : null,
          status: "processando",
          codigoStatus: body.status_sefaz ?? null,
          mensagem: body.mensagem_sefaz ?? body.mensagem ?? "Enviada",
          xmlAutorizado: null, // retrieved via consulta
          providerRef: body.ref ?? input.ref,
        };
      }

      if (res.status === 422) {
        return {
          success: false,
          chaveAcesso: null,
          protocolo: null,
          dataAutorizacao: null,
          status: "rejeitada",
          codigoStatus: body.codigo ?? body.status_sefaz ?? null,
          mensagem:
            body.mensagem_sefaz ?? body.mensagem ?? JSON.stringify(body),
          xmlAutorizado: null,
          providerRef: null,
        };
      }

      return {
        success: false,
        chaveAcesso: null,
        protocolo: null,
        dataAutorizacao: null,
        status: "erro",
        codigoStatus: res.status,
        mensagem: body.mensagem ?? `HTTP ${res.status}`,
        xmlAutorizado: null,
        providerRef: null,
      };
    } catch (error) {
      return {
        success: false,
        chaveAcesso: null,
        protocolo: null,
        dataAutorizacao: null,
        status: "erro",
        codigoStatus: null,
        mensagem:
          error instanceof Error
            ? error.message
            : "Erro de conexao com Focus NFe",
        xmlAutorizado: null,
        providerRef: null,
      };
    }
  }

  async consultar(
    ref: string,
    token: string,
  ): Promise<NfeProviderConsultaResult> {
    const baseUrl = getBaseUrl(this.ambiente);
    const url = `${baseUrl}/v2/nfe/${encodeURIComponent(ref)}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: authHeader(token),
      });

      const body = await res.json();

      const statusMap: Record<string, NfeProviderConsultaResult["status"]> = {
        autorizado: "autorizada",
        cancelado: "cancelada",
        erro_autorizacao: "rejeitada",
        processando_autorizacao: "processando",
      };

      const status = statusMap[body.status] ?? "processando";

      return {
        status,
        chaveAcesso: body.chave_nfe ?? null,
        protocolo: body.protocolo ?? null,
        dataAutorizacao: body.data_evento
          ? new Date(body.data_evento)
          : null,
        codigoStatus: body.status_sefaz ?? null,
        mensagem: body.mensagem_sefaz ?? body.mensagem ?? "",
        xmlAutorizado: null, // XML is fetched separately via /xml endpoint
      };
    } catch (error) {
      return {
        status: "erro",
        chaveAcesso: null,
        protocolo: null,
        dataAutorizacao: null,
        codigoStatus: null,
        mensagem:
          error instanceof Error ? error.message : "Erro ao consultar NF-e",
        xmlAutorizado: null,
      };
    }
  }

  async buscarXml(ref: string, token: string): Promise<string | null> {
    const baseUrl = getBaseUrl(this.ambiente);
    const url = `${baseUrl}/v2/nfe/${encodeURIComponent(ref)}.xml`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: authHeader(token),
      });

      if (res.ok) {
        return await res.text();
      }
      return null;
    } catch {
      return null;
    }
  }

  async cancelar(
    input: NfeProviderCancelInput,
  ): Promise<NfeProviderCancelResult> {
    const baseUrl = getBaseUrl(this.ambiente);
    // Focus uses the ref (chave_acesso) to cancel
    const url = `${baseUrl}/v2/nfe/${encodeURIComponent(input.chaveAcesso)}`;

    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: authHeader(input.token),
        body: JSON.stringify({
          justificativa: input.justificativa,
        }),
      });

      const body = await res.json();

      return {
        success: res.status === 200,
        protocolo: body.protocolo ?? null,
        mensagem: body.mensagem_sefaz ?? body.mensagem ?? "",
      };
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        mensagem:
          error instanceof Error ? error.message : "Erro ao cancelar NF-e",
      };
    }
  }

  async inutilizar(
    input: NfeProviderInutilizacaoInput,
  ): Promise<NfeProviderInutilizacaoResult> {
    const baseUrl = getBaseUrl(input.ambiente);
    const url = `${baseUrl}/v2/nfe/inutilizacao`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeader(input.token),
        body: JSON.stringify({
          cnpj: input.cnpj,
          serie: String(input.serie),
          numero_inicial: String(input.numeroInicial),
          numero_final: String(input.numeroFinal),
          justificativa: input.justificativa,
        }),
      });

      const body = await res.json();

      return {
        success: res.status === 200,
        protocolo: body.protocolo ?? null,
        mensagem: body.mensagem_sefaz ?? body.mensagem ?? "",
      };
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        mensagem:
          error instanceof Error
            ? error.message
            : "Erro ao inutilizar numeracao",
      };
    }
  }
}
