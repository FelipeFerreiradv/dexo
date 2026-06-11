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
  /** Referência interna usada na emissão (ex: id do NfeEmitida) — Focus cancela por ref, não por chave */
  ref: string;
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

/**
 * Input para consulta de status do serviço SEFAZ (NfeStatusServico4).
 * Provider que implementa direto sabe a UF/ambiente via construção; mantemos
 * o input opcional aqui para futuras necessidades (ex.: forçar SVC em
 * contingência).
 */
export interface NfeProviderStatusServicoInput {
  /**
   * Forçar uso de contingência (SVC-AN ou SVC-RS). Default: nenhum, usa SEFAZ
   * próprio da UF.
   */
  contingencia?: "SVC_AN" | "SVC_RS";
}

export interface NfeProviderStatusServicoResult {
  /** Provedor considera o serviço operacional (geralmente cStat=107). */
  emOperacao: boolean;
  /** Código retornado pelo serviço (107, 108, 109, ou erro). */
  cStat: number;
  /** Motivo retornado pelo SEFAZ. */
  xMotivo: string;
  /** Timestamp da resposta da SEFAZ (campo dhRecbto). */
  dataResposta: Date | null;
  /** Tempo médio de resposta em segundos (campo tMed). null se ausente. */
  tMed: number | null;
  /** Versão da aplicação SEFAZ que respondeu (verAplic). Útil para audit. */
  verAplic: string | null;
  /** UF que efetivamente respondeu (cUF). */
  cUFResposta: number | null;
}

/**
 * Carta de Correção Eletrônica (CCe) — evento 110110. Funcionalidade nova,
 * Focus NFe não suporta via API; SEFAZ direto suporta. Por isso opcional.
 */
export interface NfeProviderCartaCorrecaoInput {
  chaveAcesso: string;
  /**
   * Texto da correção. SEFAZ exige 15..1000 caracteres, sem acentos/aspas/etc.
   */
  correcao: string;
  /**
   * Sequência da CC-e (1..20). SEFAZ aceita até 20 CCes por NFe.
   */
  sequencia: number;
}

export interface NfeProviderCartaCorrecaoResult {
  success: boolean;
  protocolo: string | null;
  cStat: number | null;
  mensagem: string;
  xmlEvento: string | null;
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

  /**
   * Consulta status do serviço SEFAZ. Opcional para retrocompatibilidade
   * (Focus NFe não expõe esse serviço diretamente — sua disponibilidade fica
   * implícita pelo sucesso/falha das chamadas de emissão).
   */
  consultarStatusServico?(
    input?: NfeProviderStatusServicoInput,
  ): Promise<NfeProviderStatusServicoResult>;

  /**
   * Envia Carta de Correção Eletrônica (CCe). Opcional — Focus NFe não suporta
   * via API hoje. SEFAZ direto suporta via RecepcaoEvento4 / evento 110110.
   */
  cartaCorrecao?(
    input: NfeProviderCartaCorrecaoInput,
  ): Promise<NfeProviderCartaCorrecaoResult>;
}
