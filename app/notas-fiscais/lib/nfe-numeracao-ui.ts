// Decisões de tela da numeração V2 (lista, wizard e NumeracaoActions), em
// módulo puro para serem testadas em node (o jsdom do projeto está quebrado).
//
// Regra de ouro: a V2 se reconhece pela CHAVE `numeracao` na resposta (objeto
// ou null). Linha/resposta SEM a chave é V1 e segue exatamente o caminho de
// antes — inclusive o gate NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED, que a V2
// não usa (docs/fiscal-numeracao-v2.md: o front só promete manter o número
// quando o servidor informa `reutilizavel`).

export interface NumeracaoView {
  estado: string;
  numero: number;
  serie?: number;
  reutilizavel?: boolean;
}

/** Corpo de POST /fiscal/nfe/:id/issue e /consultar-situacao (sucesso ou erro). */
export interface RespostaNumeracao {
  success?: boolean;
  status?: string;
  numero?: number;
  serie?: number;
  chaveAcesso?: string | null;
  mensagem?: string;
  error?: string;
  code?: string;
  emAndamento?: boolean;
  numeracao?: NumeracaoView | null;
}

export type TipoToast = "success" | "error" | "warning" | "info";

export interface DesfechoTela {
  /** `undefined` = a resposta não traz a chave `numeracao` (V1): não mexer no estado da tela. */
  numeracao: NumeracaoView | null | undefined;
  toast: { msg: string; type: TipoToast } | null;
  /** Autorizada: volta para a lista depois do toast, como o handleEmitir sempre fez. */
  redirecionar: boolean;
  /** 409 NUMERACAO_CONFIRMAR_DESCARTE: o próximo clique em Emitir confirma o descarte. */
  pedirConfirmacaoDescarte: boolean;
}

/** Estados da reserva em que a tela oferece "Consultar situação". */
export const ESTADOS_CONSULTAVEIS: readonly string[] = ["INCERTO", "EM_TRANSMISSAO"];

export const MSG_EM_ANDAMENTO = "NF-e enviada, aguardando SEFAZ — use Consultar situação";

export function podeConsultarSituacao(numeracao?: NumeracaoView | null): boolean {
  return !!numeracao && ESTADOS_CONSULTAVEIS.includes(numeracao.estado);
}

// ── Lista: botão "Tentar novamente" ──

export interface LinhaTentarNovamente {
  status: string;
  serie: number;
  numero: number;
  /** V1: derivado do cStat da rejeição (findEmitted). */
  reaproveitavel?: boolean;
  /** V2: presente (objeto ou null) só em linha de config elegível à V2. */
  numeracao?: NumeracaoView | null;
}

/**
 * Linha V2 (tem a chave `numeracao`): o botão depende SÓ de
 * `numeracao.reutilizavel` — a V2 grava REJECTED sem cStat em recusa pré-envio
 * (ex.: Focus 422), então o `reaproveitavel` da V1 sairia false com o nº mantido,
 * e sairia true com o nº já consumido (206/205/301-303).
 * Linha sem a chave: regra V1 intacta (flag NEXT_PUBLIC + cStat).
 */
export function mostrarTentarNovamente(nota: LinhaTentarNovamente, reemissaoV1Enabled: boolean): boolean {
  if (nota.status !== "REJECTED") return false;
  if (nota.numeracao !== undefined) return nota.numeracao?.reutilizavel === true;
  return reemissaoV1Enabled && !!nota.reaproveitavel;
}

export function rotuloTentarNovamente(nota: LinhaTentarNovamente): string {
  if (nota.numeracao) return `Tentar novamente — mantém o nº ${nota.numeracao.numero}`;
  return `Tentar novamente — reaproveita o nº ${nota.serie}/${nota.numero}`;
}

// ── Wizard: desfecho da emissão e da consulta ──

function numeracaoDaResposta(d: RespostaNumeracao): NumeracaoView | null | undefined {
  return "numeracao" in d ? (d.numeracao ?? null) : undefined;
}

/**
 * Emissão/consulta ainda sem desfecho (claim perdido, 202 do Focus, INCERTO).
 * SENDING só conta aqui na resposta da V2 (`numeracao`/`emAndamento`): a V1
 * devolve SENDING com success:false quando o provedor dá "erro", e isso segue
 * sendo erro.
 */
export function respostaEmAndamento(d: RespostaNumeracao): boolean {
  if (d.emAndamento === true) return true;
  return d.status === "SENDING" && ("numeracao" in d || "emAndamento" in d);
}

function toastAutorizada(d: RespostaNumeracao): DesfechoTela["toast"] {
  return { msg: `NF-e ${d.numero} autorizada! Chave: ${d.chaveAcesso?.slice(0, 20)}...`, type: "success" };
}

/** O que o handleEmitir do wizard faz com a resposta de POST /issue. */
export function desfechoEmissao(ok: boolean, d: RespostaNumeracao): DesfechoTela {
  const numeracao = numeracaoDaResposta(d);
  const base = { numeracao, redirecionar: false, pedirConfirmacaoDescarte: false };
  if (!ok) {
    return {
      ...base,
      pedirConfirmacaoDescarte: d.code === "NUMERACAO_CONFIRMAR_DESCARTE",
      toast: { msg: d.error || "Erro ao emitir NF-e", type: "error" },
    };
  }
  if (d.success) {
    if (d.status === "AUTHORIZED") return { ...base, toast: toastAutorizada(d), redirecionar: true };
    return { ...base, toast: { msg: d.mensagem || "NF-e enviada, aguardando SEFAZ", type: "info" } };
  }
  if (respostaEmAndamento(d)) {
    // Nunca erro: a nota foi (ou está sendo) transmitida. Só manda consultar
    // quando a tela de fato oferece o botão.
    const msg = podeConsultarSituacao(numeracao) ? MSG_EM_ANDAMENTO : d.mensagem || "NF-e enviada, aguardando SEFAZ";
    return { ...base, toast: { msg, type: "info" } };
  }
  return { ...base, toast: { msg: d.mensagem || "NF-e rejeitada pela SEFAZ", type: "error" } };
}

/**
 * O que o wizard faz com a resposta de POST /consultar-situacao (repassada pelo
 * NumeracaoActions). Não recarrega por GET /fiscal/nfe/draft/:id: ele só
 * devolve DRAFT/REJECTED e dá 404 justamente para SENDING/AUTHORIZED.
 */
export function desfechoConsulta(d: RespostaNumeracao): DesfechoTela {
  const numeracao = numeracaoDaResposta(d);
  const base = { numeracao, redirecionar: false, pedirConfirmacaoDescarte: false };
  if (d.status === "AUTHORIZED") return { ...base, toast: toastAutorizada(d), redirecionar: true };
  // Sem reserva viva o NumeracaoActions some da tela (com ele, a mensagem da
  // consulta): o desfecho não pode ficar mudo.
  if (numeracao === null && d.mensagem) {
    return { ...base, toast: { msg: d.mensagem, type: respostaEmAndamento(d) ? "info" : "error" } };
  }
  return { ...base, toast: null };
}
