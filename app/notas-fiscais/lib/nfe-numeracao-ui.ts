// Decisões de tela da numeração V2 (lista, wizard e NumeracaoActions), em
// módulo puro para serem testadas em node (o jsdom do projeto está quebrado).
//
// Regra de ouro: a V2 se reconhece pela CHAVE `numeracao` na resposta (objeto
// ou null). Linha/resposta SEM a chave é V1 e segue exatamente o caminho de
// antes — inclusive o gate NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED, que a V2
// não usa (docs/fiscal-numeracao-v2.md: o front só promete manter o número
// quando o servidor informa `reutilizavel`).
//
// Na lista/ficha a chave só vem quando a nota tem alguma reserva no ledger
// (attachFiscalLista). A nota de config V2 que NUNCA teve reserva (V1 rejeitada
// antes da virada) chega sem a chave e com `legadoV1`: regra V1, rótulo neutro.

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
  /** Erro de domínio da numeração ({error, code, detalhes}): dados do 409. */
  detalhes?: Record<string, unknown> | null;
  emAndamento?: boolean;
  numeracao?: NumeracaoView | null;
}

export type TipoToast = "success" | "error" | "warning" | "info";

/**
 * 409 SEQUENCIA_ATRAS_DA_SEFAZ: o contador da série está atrás da numeração real
 * do CNPJ e nenhuma NF-e da série sai até ajustar. Campos nulos quando o
 * servidor não os mandou — a tela nunca inventa série nem piso.
 */
export interface SequenciaAtrasView {
  mensagem: string;
  serie: number | null;
  ambiente: string | null;
  modelo: string | null;
  numeros: number[];
  /** `detalhes.proximoNumeroMinimo`: só INFORMADO na tela, nunca pré-preenchido. */
  pisoSugerido: number | null;
}

export interface DesfechoTela {
  /** `undefined` = a resposta não traz a chave `numeracao` (V1): não mexer no estado da tela. */
  numeracao: NumeracaoView | null | undefined;
  toast: { msg: string; type: TipoToast } | null;
  /** Autorizada: volta para a lista depois do toast, como o handleEmitir sempre fez. */
  redirecionar: boolean;
  /** 409 NUMERACAO_CONFIRMAR_DESCARTE: o próximo clique em Emitir confirma o descarte. */
  pedirConfirmacaoDescarte: boolean;
  /** Só no 409 SEQUENCIA_ATRAS_DA_SEFAZ (ausente nos demais): o wizard mostra o quadro FIXO do ajuste. */
  sequenciaAtras?: SequenciaAtrasView;
}

/** Estados da reserva em que a tela oferece "Consultar situação". */
export const ESTADOS_CONSULTAVEIS: readonly string[] = ["INCERTO", "EM_TRANSMISSAO"];

export const MSG_EM_ANDAMENTO = "NF-e enviada, aguardando SEFAZ — use Consultar situação";

export function podeConsultarSituacao(numeracao?: NumeracaoView | null): boolean {
  return !!numeracao && ESTADOS_CONSULTAVEIS.includes(numeracao.estado);
}

// ── NumeracaoActions: texto do estado e as ações de cada linha ──
//
// BLOQUEADO (613 sem chave referida, consulta 100 com chave alheia, 101/151/155)
// é a reserva que só sai por conferência humana: o "Emitir" responde 409
// NUMERACAO_BLOQUEADA e "Consultar" não move nada. Antes a tela mostrava o enum
// cru e nenhum botão — nota morta, quando no V1 ela seria reemitida com número
// novo. As duas saídas valem SÓ para a linha com a chave `numeracao` em
// BLOQUEADO: linha V1 (sem a chave) não ganha nada, porque o DELETE apagaria a
// nota V1 sem confirmação nenhuma.

export const ROTULO_EXCLUIR_RASCUNHO = "Excluir rascunho";
export const ROTULO_RETOMAR_EMISSAO = "Retomar emissão";
/** Confirmação do descarte do nº BLOQUEADO (o do DELETE é o das devoluções). */
export const ROTULO_CONFIRMAR_DESCARTE_NUMERO = "Confirmo: descartar o número";

export function rotuloDescartarNumero(numero: number): string {
  return `Descartar o nº ${numero} e emitir com número novo`;
}

/** O que vem depois de "Nº X: ". Só o BLOQUEADO mudou; os outros saem como antes. */
export function textoEstadoNumeracao(n: NumeracaoView): string {
  if (n.reutilizavel) return "mantido para nova tentativa";
  if (n.estado === "BLOQUEADO") return "retido para conferência";
  return n.estado;
}

export function ajudaBloqueado(n: Pick<NumeracaoView, "numero">): string {
  return `A SEFAZ não confirmou se o nº ${n.numero} já foi usado. Confira no portal da SEFAZ: se ele NÃO foi autorizado para esta nota, descarte o número e emita com um novo (ou exclua o rascunho). Se o contador da série estiver atrás da numeração real, ajuste o próximo número em Configuração fiscal › Ambiente & Provedor.`;
}

export interface AcoesNumeracao {
  consultar: boolean;
  /** Rótulo do descarte do nº BLOQUEADO (POST .../numeracao/descartar-bloqueado) ou null. */
  descartarNumero: string | null;
  /** "Excluir rascunho" (DELETE com a confirmação do número) — só no BLOQUEADO. */
  excluirRascunho: string | null;
  /** "Retomar emissão" (POST /issue direto) — só com `retomavel` do servidor. */
  retomar: string | null;
}

/**
 * `retomavel` vem do servidor (attachFiscalLista, pela mesma `decidirEntrada` do
 * orquestrador): VALIDATING/SIGNING travada antes do envio. Vale até sem reserva
 * (nota nunca numerada), por isso não depende de `numeracao`.
 */
export function acoesNumeracao(numeracao?: NumeracaoView | null, retomavel?: boolean): AcoesNumeracao {
  const bloqueado = numeracao?.estado === "BLOQUEADO";
  return {
    consultar: podeConsultarSituacao(numeracao),
    descartarNumero: bloqueado ? rotuloDescartarNumero(numeracao!.numero) : null,
    excluirRascunho: bloqueado ? ROTULO_EXCLUIR_RASCUNHO : null,
    retomar: retomavel === true ? ROTULO_RETOMAR_EMISSAO : null,
  };
}

/** Depois do descarte a nota volta a rascunho (e some da lista): é no assistente que ela emite. */
export function urlEmitirDeNovo(nfeId: string): string {
  return `/notas-fiscais/nfe?draft=${encodeURIComponent(nfeId)}`;
}

export type ResultadoDescarteNumero =
  | { ok: true; numeroDescartado: number; serie: number | null }
  /** 409 NUMERACAO_CONFIRMAR_DESCARTE: pedir a confirmação e repetir com `confirmar`. */
  | { ok: false; confirmar: true; mensagem: string }
  | { ok: false; confirmar: false; mensagem: string };

export const DESCARTE_NUMERO_FALHOU = "Não foi possível descartar o número. Tente de novo em instantes.";

function inteiroOuNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function erroDoCorpo(corpo: unknown, padrao: string): string {
  const e = corpo && typeof corpo === "object" ? (corpo as { error?: unknown }).error : null;
  return typeof e === "string" && e.trim() !== "" ? e : padrao;
}

/**
 * POST /fiscal/nfe/:id/numeracao/descartar-bloqueado (contrato C2). O 1º clique
 * vai SEM `confirmar`: é o servidor que diz qual número e o que conferir, e a
 * confirmação é da pessoa. Depois do 200 a nota volta a rascunho com o número
 * provisório e o próximo "Emitir" reserva um número novo.
 */
export async function descartarNumeroBloqueado(p: {
  base: string;
  email: string;
  nfeId: string;
  confirmar?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<ResultadoDescarteNumero> {
  const f = p.fetchImpl ?? fetch;
  try {
    const res = await f(`${p.base}/fiscal/nfe/${encodeURIComponent(p.nfeId)}/numeracao/descartar-bloqueado`, {
      method: "POST",
      headers: { "Content-Type": "application/json", email: p.email },
      body: JSON.stringify(p.confirmar ? { confirmar: true } : {}),
    });
    const corpo = (await res.json().catch(() => ({}))) as { code?: unknown; numeroDescartado?: unknown; serie?: unknown };
    if (res.ok) return { ok: true, numeroDescartado: Number(corpo.numeroDescartado), serie: inteiroOuNull(corpo.serie) };
    const mensagem = erroDoCorpo(corpo, DESCARTE_NUMERO_FALHOU);
    if (res.status === 409 && corpo.code === "NUMERACAO_CONFIRMAR_DESCARTE" && !p.confirmar) {
      return { ok: false, confirmar: true, mensagem: `${mensagem.replace(/\.?$/, ".")} Descartado, a nota volta a ser rascunho e, ao emitir, sai com um número novo.` };
    }
    return { ok: false, confirmar: false, mensagem };
  } catch {
    return { ok: false, confirmar: false, mensagem: DESCARTE_NUMERO_FALHOU };
  }
}

/**
 * B8: "Retomar emissão" da nota VALIDATING/SIGNING travada. POST /issue DIRETO —
 * nunca pelo wizard: o GET /draft/:id dá 404 para VALIDATING e o wizard criaria
 * um rascunho novo em silêncio. A frase é a mesma do desfecho da emissão.
 */
export async function retomarEmissao(p: {
  base: string;
  email: string;
  nfeId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; corpo: RespostaNumeracao; mensagem: string }> {
  const f = p.fetchImpl ?? fetch;
  try {
    const res = await f(`${p.base}/fiscal/nfe/${encodeURIComponent(p.nfeId)}/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", email: p.email },
      body: JSON.stringify({}),
    });
    const corpo = (await res.json().catch(() => ({}))) as RespostaNumeracao;
    return { ok: res.ok, corpo, mensagem: desfechoEmissao(res.ok, corpo).toast?.msg ?? "" };
  } catch {
    return { ok: false, corpo: {}, mensagem: "Erro de conexao ao emitir NF-e" };
  }
}

// ── Inutilização V2: número preso em nota não emitida (contrato C1) ──

export interface ConfirmacaoInutilizacao {
  numeros: number[];
  serie: number | null;
  /** A frase do servidor (para BLOQUEADO ela pede para confirmar que NÃO foi autorizado). */
  mensagem: string;
}

/**
 * 409 NUMERACAO_CONFIRMAR_DESCARTE da POST /fiscal/inutilizacao ⇒ o que a tela
 * pergunta antes de repetir com `confirmarDescarteNumeros:true`. Sem a lista de
 * números não há o que confirmar: null, e a tela segue com o toast de sempre.
 */
export function lerConfirmacaoInutilizacao(status: number, corpo: unknown): ConfirmacaoInutilizacao | null {
  if (status !== 409 || !corpo || typeof corpo !== "object") return null;
  const c = corpo as { code?: unknown; error?: unknown; detalhes?: unknown };
  if (c.code !== "NUMERACAO_CONFIRMAR_DESCARTE") return null;
  const d = c.detalhes && typeof c.detalhes === "object" ? (c.detalhes as { numeros?: unknown; serie?: unknown }) : {};
  const numeros = Array.isArray(d.numeros) ? d.numeros.filter((n): n is number => typeof n === "number" && Number.isInteger(n)) : [];
  if (!numeros.length) return null;
  return { numeros, serie: inteiroOuNull(d.serie), mensagem: erroDoCorpo(c, "") };
}

export function textoConfirmacaoInutilizacao(c: ConfirmacaoInutilizacao): string {
  const serie = c.serie !== null ? ` da série ${c.serie}` : "";
  const um = c.numeros.length === 1;
  const quais = um
    ? `O nº ${c.numeros[0]}${serie} está reservado para uma nota que ainda não foi autorizada`
    : `Os nºs ${c.numeros.join(", ")}${serie} estão reservados para notas que ainda não foram autorizadas`;
  return `${quais} (rascunho, rejeitada ou retida para conferência). Ao confirmar, ${um ? "esse número sai da nota e é inutilizado" : "esses números saem das notas e são inutilizados"} junto com a faixa; se ${um ? "ela" : "alguma delas"} for emitida depois, sai com um número novo. Confirme só se nenhum deles foi autorizado na SEFAZ.`;
}

// ── Wizard: contador atrás da SEFAZ (B6) ──

export const TITULO_SEQUENCIA_ATRAS = "O contador desta série está atrás da SEFAZ";

function sequenciaAtrasDaResposta(d: RespostaNumeracao): SequenciaAtrasView {
  const det: Record<string, unknown> = d.detalhes && typeof d.detalhes === "object" ? d.detalhes : {};
  const texto = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return {
    mensagem: d.error || "Erro ao emitir NF-e",
    serie: inteiroOuNull(det.serie),
    ambiente: texto(det.ambiente),
    modelo: texto(det.modelo),
    numeros: Array.isArray(det.numeros) ? det.numeros.filter((n): n is number => typeof n === "number" && Number.isInteger(n)) : [],
    pisoSugerido: inteiroOuNull(det.proximoNumeroMinimo),
  };
}

/** Texto de apoio do card de ajuste: o mínimo é informado, o campo fica em branco. */
export function avisoPisoSugerido(piso: number | null | undefined): string | null {
  if (typeof piso !== "number" || !Number.isInteger(piso)) return null;
  return `Pela resposta da SEFAZ, o próximo número precisa ser ${piso} ou mais — e maior que o último número que este CNPJ já usou nesta série (confira no portal da SEFAZ). O campo fica em branco de propósito: digite o número que você conferiu.`;
}

// ── Lista: botão "Tentar novamente" ──

export interface LinhaTentarNovamente {
  status: string;
  serie: number;
  numero: number;
  /** V1: derivado do cStat da rejeição (findEmitted). */
  reaproveitavel?: boolean;
  /** V2: presente (objeto ou null) só em linha de config elegível à V2 que tem reserva no ledger. */
  numeracao?: NumeracaoView | null;
  /**
   * Config elegível à V2, mas a nota NUNCA teve reserva (V1 rejeitada antes da
   * virada): sem a chave `numeracao`, segue a regra do V1 (flag + cStat) com o
   * rótulo neutro — quem decide se o número é adotado é o servidor.
   */
  legadoV1?: boolean;
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
  // Legado V1 numa config V2: a adoção do nº pode ser recusada (sem trilha,
  // inutilizado…) e a nota sair com outro — não prometer o número.
  if (nota.legadoV1) return "Tentar novamente";
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
      // O toast é o mesmo de antes; o quadro fixo é a mais (B6).
      ...(d.code === "SEQUENCIA_ATRAS_DA_SEFAZ" ? { sequenciaAtras: sequenciaAtrasDaResposta(d) } : {}),
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
