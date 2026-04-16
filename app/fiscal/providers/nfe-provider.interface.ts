/**
 * Interface abstrata para provedores de NF-e (Focus NFe, NFe.io, etc).
 * Permite trocar de provedor sem alterar usecases/routes.
 */

export interface NfeProviderEmitInput {
  /** JSON completo da NF-e no formato esperado pelo provedor */
  nfeData: Record<string, any>;
  /** Token de autenticação do provedor */
  token: string;
  /** Referência interna (ex: id do NfeEmitida) */
  ref: string;
}

export interface NfeProviderEmitResult {
  success: boolean;
  /** Chave de acesso 44 dígitos (se autorizada) */
  chaveAcesso: string | null;
  /** Protocolo de autorização SEFAZ */
  protocolo: string | null;
  /** Data de autorização */
  dataAutorizacao: Date | null;
  /** Status retornado pelo provedor */
  status: "autorizada" | "rejeitada" | "processando" | "erro";
  /** Código SEFAZ (ex: 100 = autorizada) */
  codigoStatus: number | null;
  /** Motivo de rejeição ou mensagem */
  mensagem: string;
  /** XML autorizado retornado pelo provedor */
  xmlAutorizado: string | null;
  /** Referência do provedor (ex: id Focus) */
  providerRef: string | null;
}

export interface NfeProviderConsultaResult {
  status: "autorizada" | "rejeitada" | "processando" | "cancelada" | "erro";
  chaveAcesso: string | null;
  protocolo: string | null;
  dataAutorizacao: Date | null;
  codigoStatus: number | null;
  mensagem: string;
  xmlAutorizado: string | null;
}

export interface NfeProviderCancelInput {
  chaveAcesso: string;
  protocolo: string;
  justificativa: string;
  token: string;
}

export interface NfeProviderCancelResult {
  success: boolean;
  protocolo: string | null;
  mensagem: string;
}

export interface NfeProviderInutilizacaoInput {
  cnpj: string;
  serie: number;
  numeroInicial: number;
  numeroFinal: number;
  justificativa: string;
  token: string;
  ambiente: "homologacao" | "producao";
}

export interface NfeProviderInutilizacaoResult {
  success: boolean;
  protocolo: string | null;
  mensagem: string;
}

export interface INfeProvider {
  readonly name: string;

  /** Envia NF-e para autorização */
  emitir(input: NfeProviderEmitInput): Promise<NfeProviderEmitResult>;

  /** Consulta status de NF-e já enviada */
  consultar(ref: string, token: string): Promise<NfeProviderConsultaResult>;

  /** Cancela NF-e autorizada */
  cancelar(input: NfeProviderCancelInput): Promise<NfeProviderCancelResult>;

  /** Inutiliza faixa de numeração */
  inutilizar(
    input: NfeProviderInutilizacaoInput,
  ): Promise<NfeProviderInutilizacaoResult>;
}
