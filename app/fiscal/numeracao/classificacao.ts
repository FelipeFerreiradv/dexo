/**
 * Numeração V2 — classificação PURA dos resultados dos provedores fiscais.
 *
 * Um único classificador para SEFAZ direto (envio e consulta) e Focus (POST e
 * GET). Nunca decide renumerar: o pior caso é INCERTO ou BLOQUEADO, e a
 * consulta vem antes de qualquer reenvio. Ver docs/fiscal-numeracao-v2.md,
 * plano §4.3 e design §4.8.
 *
 * Convenção do `Classificacao` (contrato em ./tipos):
 *  - `acao === "NENHUMA"` ⇒ `estadoAlvo` preenchido (a resposta decide);
 *  - `acao !== "NENHUMA"` ⇒ `estadoAlvo === null` (depende do seguimento; se o
 *    seguimento não resolver, a reserva fica INCERTO — nunca renumera);
 *  - `conclusiva` = a resposta prova que ESTA tentativa terminou sem autorização
 *    (base do `provaMadura` e do fechamento da tentativa);
 *  - `mensagem` em pt-BR, só com o motivo do provedor (nunca token/credencial).
 *
 * Módulo PURO: sem env, sem rede, sem `node:*`. Os tempos de espera (656/429)
 * entram por `opcoes` (o orquestrador passa os valores de `app/fiscal/flags.ts`).
 */

import type {
  AcaoSeguimento,
  ClasseResultado,
  Classificacao,
  EstadoReserva,
  FocusV2Corpo,
  FocusV2Resposta,
  SefazConsultaDetalhada,
  SefazTransmissao,
  Transporte,
} from "./tipos";
import { codigoProvedorNaoNumerico, normalizarCStat } from "./cstat";

export { codigoProvedorNaoNumerico, normalizarCStat } from "./cstat";

export interface OpcoesClassificacao {
  /** Espera após cStat 656. Default 3 600 000 ms (60 min). */
  consumoIndevidoCooldownMs?: number;
  /** Espera após Focus 429 sem `Retry-After`. Default 60 000 ms. */
  rateLimitPadraoMs?: number;
}

const COOLDOWN_656_PADRAO_MS = 3_600_000;
const RATE_LIMIT_PADRAO_MS = 60_000;

const DENEGACAO = new Set([110, 301, 302, 303]);
const DUPLICIDADE_OUTRA_CHAVE = new Set([539, 562, 613]);
const SERVICO_INDISPONIVEL = new Set([108, 109]);
const CANCELADA = new Set([101, 151, 155]);

const TAMANHO_MAX_DETALHE = 300;

// ─────────────────────────────── utilitários ───────────────────────────────

function montar(
  p: Pick<Classificacao, "classe" | "mensagem"> & Partial<Classificacao>,
): Classificacao {
  return {
    classe: p.classe,
    estadoAlvo: p.estadoAlvo ?? null,
    acao: p.acao ?? "NENHUMA",
    cStat: p.cStat ?? null,
    codigoProvedor: p.codigoProvedor ?? null,
    conclusiva: p.conclusiva ?? false,
    chaveReferida: p.chaveReferida ?? null,
    retryAposMs: p.retryAposMs ?? null,
    mensagem: p.mensagem,
  };
}

/** Texto externo compacto (espaços colapsados, truncado). */
function texto(v: unknown, max = TAMANHO_MAX_DETALHE): string {
  if (typeof v !== "string") return "";
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function comDetalhe(base: string, detalhe: string): string {
  return detalhe ? `${base}: ${detalhe}` : base;
}

function soDigitos(v: unknown): string {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}

function chave44(v: unknown): string | null {
  const d = soDigitos(v);
  return d.length === 44 ? d : null;
}

function temTexto(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function msPositivo(v: unknown, padrao: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.ceil(v) : padrao;
}

function descreverTransporte(t: Transporte): string {
  switch (t) {
    case "TIMEOUT":
      return "tempo de resposta esgotado";
    case "REDE":
      return "falha de rede";
    case "SEM_CREDENCIAL":
      return "sem credencial para comunicar";
    default:
      return "sem resposta legível";
  }
}

/**
 * Primeira sequência de EXATAMENTE 44 dígitos no texto (chave citada no xMotivo
 * de 539/562/613, ex.: "[chNFe:3526…]"). Sequências maiores são ignoradas.
 */
export function extrairChaveReferida(textoLivre: unknown): string | null {
  if (typeof textoLivre !== "string" || !textoLivre) return null;
  const re = /(?:^|\D)(\d{44})(?!\d)/g;
  const m = re.exec(textoLivre);
  return m ? m[1] : null;
}

/**
 * Um "não consta" (SEFAZ 217 / Focus 404) só prova que a tentativa não chegou
 * quando a tentativa já teve resposta conclusiva, ou quando passou tempo
 * suficiente para esgotar o pior caso do transporte (`minMs`, ver flags.ts).
 */
export function provaMadura(
  t: { transmitidaEm: Date; respostaConclusiva: boolean },
  agora: Date,
  minMs: number,
): boolean {
  if (t.respostaConclusiva === true) return true;
  const inicio = t.transmitidaEm instanceof Date ? t.transmitidaEm.getTime() : NaN;
  const fim = agora instanceof Date ? agora.getTime() : NaN;
  if (!Number.isFinite(inicio) || !Number.isFinite(fim)) return false;
  if (!Number.isFinite(minMs) || minMs < 0) return false;
  return fim - inicio >= minMs;
}

// ───────────────────────── Tabela A: cStat da SEFAZ ─────────────────────────

/**
 * Tabela A (resposta a um ENVIO) aplicada a um cStat já normalizado.
 * Exportada porque a adoção de legado (decisao.ts, evidência B) usa a mesma
 * régua: só `estadoAlvo === "REJEITADO"` é rejeição comum.
 */
export function classificarCStatSefaz(
  cStat: number | null,
  ctx: { nProt?: string | null; xMotivo?: string | null } = {},
  opcoes: OpcoesClassificacao = {},
): Classificacao {
  const motivo = texto(ctx.xMotivo);
  if (cStat === null) {
    return montar({
      classe: "INCERTO_TRANSPORTE",
      acao: "CONSULTAR_CHAVE",
      mensagem: "Envio sem cStat legível — confirmando a situação por consulta à chave",
    });
  }
  const rotulo = (base: string) => comDetalhe(`${base} (cStat ${cStat})`, motivo);

  if (cStat === 100 || cStat === 150) {
    if (temTexto(ctx.nProt)) {
      return montar({
        classe: "AUTORIZADA",
        estadoAlvo: "AUTORIZADO",
        cStat,
        mensagem: rotulo("NF-e autorizada"),
      });
    }
    return montar({
      classe: "AUTORIZADA",
      acao: "CONSULTAR_CHAVE",
      cStat,
      mensagem: rotulo("Autorização sem protocolo legível — confirmando por consulta à chave"),
    });
  }
  if (DENEGACAO.has(cStat)) {
    if (temTexto(ctx.nProt)) {
      return montar({
        classe: "DENEGADA",
        estadoAlvo: "DENEGADO",
        cStat,
        conclusiva: true,
        mensagem: rotulo("Uso denegado"),
      });
    }
    return montar({
      classe: "DENEGACAO_A_CONFIRMAR",
      acao: "CONSULTAR_CHAVE",
      cStat,
      mensagem: rotulo("Denegação sem protocolo — confirmando por consulta à chave"),
    });
  }
  if (cStat === 103) {
    return montar({
      classe: "EM_PROCESSAMENTO",
      acao: "POLL_RECIBO",
      cStat,
      mensagem: rotulo("Lote recebido e em processamento na SEFAZ"),
    });
  }
  if (cStat === 104 || cStat === 105) {
    return montar({
      classe: "EM_PROCESSAMENTO",
      acao: "POLL_CHAVE",
      cStat,
      mensagem: rotulo("Lote em processamento na SEFAZ — consultando pela chave"),
    });
  }
  if (SERVICO_INDISPONIVEL.has(cStat)) {
    return montar({
      classe: "SERVICO_INDISPONIVEL",
      estadoAlvo: "RESERVADO",
      cStat,
      conclusiva: true,
      mensagem: rotulo("SEFAZ indisponível — tente novamente mais tarde"),
    });
  }
  if (cStat === 204) {
    return montar({
      classe: "DUPLICIDADE_MESMA_CHAVE",
      acao: "CONSULTAR_CHAVE",
      cStat,
      chaveReferida: extrairChaveReferida(ctx.xMotivo),
      mensagem: rotulo("Duplicidade de NF-e — confirmando por consulta à chave"),
    });
  }
  if (cStat === 205) {
    return montar({
      classe: "DENEGADA_NA_BASE",
      acao: "CONSULTAR_CHAVE",
      cStat,
      mensagem: rotulo("NF-e denegada na base da SEFAZ — confirmando por consulta à chave"),
    });
  }
  if (cStat === 206) {
    return montar({
      classe: "INUTILIZADA_NA_BASE",
      estadoAlvo: "INUTILIZADO",
      cStat,
      conclusiva: true,
      mensagem: rotulo("Número já inutilizado na SEFAZ"),
    });
  }
  if (cStat === 218) {
    return montar({
      classe: "CANCELADA_NA_BASE",
      acao: "CONSULTAR_CHAVE",
      cStat,
      mensagem: rotulo("NF-e já cancelada na base da SEFAZ — confirmando por consulta à chave"),
    });
  }
  if (DUPLICIDADE_OUTRA_CHAVE.has(cStat)) {
    return montar({
      classe: "DUPLICIDADE_OUTRA_CHAVE",
      acao: "RECONCILIAR_539",
      cStat,
      conclusiva: true,
      chaveReferida: extrairChaveReferida(ctx.xMotivo),
      mensagem: rotulo("Número já usado por outra chave — conferindo as chaves das tentativas"),
    });
  }
  if (cStat === 635) {
    return montar({
      classe: "EM_PROCESSAMENTO_NA_SEFAZ",
      estadoAlvo: "INCERTO",
      cStat,
      mensagem: rotulo(
        "NF-e com o mesmo número e série aguardando processamento na SEFAZ — use Consultar situação",
      ),
    });
  }
  if (cStat === 656) {
    return montar({
      classe: "CONSUMO_INDEVIDO",
      estadoAlvo: "REJEITADO",
      cStat,
      conclusiva: true,
      retryAposMs: msPositivo(opcoes.consumoIndevidoCooldownMs, COOLDOWN_656_PADRAO_MS),
      mensagem: rotulo("Consumo indevido do serviço da SEFAZ — aguarde antes de reenviar"),
    });
  }
  if (cStat >= 200) {
    return montar({
      classe: "REJEICAO",
      estadoAlvo: "REJEITADO",
      cStat,
      conclusiva: true,
      mensagem: rotulo("Rejeição"),
    });
  }
  // 0–199 não listados (ex.: 101, 102, 135, 217): não é rejeição nem autorização.
  return montar({
    classe: "DESCONHECIDO",
    acao: "CONSULTAR_CHAVE",
    cStat,
    mensagem: rotulo("Retorno não reconhecido da SEFAZ — confirmando por consulta à chave"),
  });
}

// ───────────────────────── SEFAZ direto: envio ─────────────────────────

export function classificarEnvioSefaz(
  t: SefazTransmissao,
  opcoes: OpcoesClassificacao = {},
): Classificacao {
  if (t.transporte !== null) {
    return montar({
      classe: "INCERTO_TRANSPORTE",
      acao: "CONSULTAR_CHAVE",
      mensagem: `Envio à SEFAZ sem confirmação (${descreverTransporte(t.transporte)}) — confirmando por consulta à chave`,
    });
  }
  if (t.httpStatus !== null && t.httpStatus >= 400) {
    return montar({
      classe: "INCERTO_TRANSPORTE",
      acao: "CONSULTAR_CHAVE",
      mensagem: `SEFAZ respondeu HTTP ${t.httpStatus} — confirmando por consulta à chave`,
    });
  }

  const prot = normalizarCStat(t.protCStat);
  if (prot !== null) {
    return classificarCStatSefaz(prot, { nProt: t.nProt, xMotivo: t.protXMotivo }, opcoes);
  }

  const lote = normalizarCStat(t.loteCStat);
  if (lote === null) {
    return montar({
      classe: "INCERTO_TRANSPORTE",
      acao: "CONSULTAR_CHAVE",
      mensagem: "Resposta da SEFAZ sem cStat legível — confirmando por consulta à chave",
    });
  }
  if (lote === 103 && !temTexto(t.nRec)) {
    return montar({
      classe: "EM_PROCESSAMENTO",
      acao: "POLL_CHAVE",
      cStat: lote,
      mensagem: comDetalhe(
        "Lote em processamento sem número de recibo (cStat 103) — consultando pela chave",
        texto(t.loteXMotivo),
      ),
    });
  }
  if (lote === 104) {
    return montar({
      classe: "EM_PROCESSAMENTO",
      acao: "POLL_CHAVE",
      cStat: lote,
      mensagem: comDetalhe(
        "Lote processado sem o protocolo da NF-e (cStat 104) — consultando pela chave",
        texto(t.loteXMotivo),
      ),
    });
  }
  // cStat só no lote: não há protocolo da NF-e (nProt vazio ⇒ 100/110 sem prova vão para consulta).
  return classificarCStatSefaz(lote, { nProt: null, xMotivo: t.loteXMotivo }, opcoes);
}

// ───────────────────────── SEFAZ direto: consulta ─────────────────────────

function consultaInconclusiva(
  mensagem: string,
  extra: Partial<Classificacao> = {},
): Classificacao {
  return montar({
    classe: "CONSULTA_INCONCLUSIVA",
    estadoAlvo: "INCERTO",
    ...extra,
    mensagem,
  });
}

export function classificarConsultaSefaz(
  c: SefazConsultaDetalhada,
  ctx: { chavesNossas: string[]; digestsNossos: string[]; madura: boolean },
  opcoes: OpcoesClassificacao = {},
): Classificacao {
  if (c.transporte !== null) {
    return consultaInconclusiva(
      `Consulta à SEFAZ sem resposta (${descreverTransporte(c.transporte)}) — tente novamente em alguns minutos`,
    );
  }
  if (c.httpStatus !== null && c.httpStatus >= 400) {
    return consultaInconclusiva(
      `Consulta à SEFAZ respondeu HTTP ${c.httpStatus} — tente novamente em alguns minutos`,
    );
  }
  const cStat = normalizarCStat(c.cStat);
  const motivo = texto(c.xMotivo);
  if (cStat === null) {
    return consultaInconclusiva("Consulta à SEFAZ sem cStat legível — tente novamente em alguns minutos");
  }
  const rotulo = (base: string) => comDetalhe(`${base} (cStat ${cStat})`, motivo);

  if (cStat === 100 || cStat === 150) {
    const chave = chave44(c.chNFe);
    const nossas = new Set(ctx.chavesNossas.map(soDigitos));
    if (!chave || !nossas.has(chave)) {
      return montar({
        classe: "DUPLICIDADE_OUTRA_CHAVE",
        estadoAlvo: "BLOQUEADO",
        cStat,
        mensagem: rotulo(
          "Consulta retornou NF-e autorizada com chave que não é de nenhuma tentativa deste número — conferência manual",
        ),
      });
    }
    const digVal = typeof c.digVal === "string" && c.digVal.trim() ? c.digVal.trim() : null;
    if (digVal !== null) {
      const digests = new Set(ctx.digestsNossos.map((d) => (typeof d === "string" ? d.trim() : "")));
      if (!digests.has(digVal)) {
        return montar({
          classe: "DUPLICIDADE_MESMA_CHAVE",
          estadoAlvo: "BLOQUEADO",
          cStat,
          mensagem: rotulo(
            "NF-e autorizada com conteúdo (digest) diferente das tentativas registradas — conferência manual",
          ),
        });
      }
    }
    if (!temTexto(c.nProt)) {
      return consultaInconclusiva(rotulo("Consulta indica autorização sem protocolo legível — consulte novamente"), {
        cStat,
      });
    }
    return montar({
      classe: "AUTORIZADA",
      estadoAlvo: "AUTORIZADO",
      cStat,
      mensagem: rotulo("NF-e autorizada (confirmada por consulta)"),
    });
  }
  if (DENEGACAO.has(cStat)) {
    return montar({
      classe: "DENEGADA",
      estadoAlvo: "DENEGADO",
      cStat,
      conclusiva: true,
      mensagem: rotulo("Uso denegado (confirmado por consulta)"),
    });
  }
  if (CANCELADA.has(cStat)) {
    return montar({
      classe: "CANCELADA_FORA_DO_FLUXO",
      estadoAlvo: "BLOQUEADO",
      cStat,
      mensagem: rotulo("NF-e cancelada fora do fluxo do Dexo — conferência manual"),
    });
  }
  if (cStat === 217) {
    if (ctx.madura) {
      return montar({
        classe: "NAO_CONSTA",
        estadoAlvo: "RESERVADO",
        cStat,
        conclusiva: true,
        mensagem: rotulo("Envio não registrado na SEFAZ"),
      });
    }
    return consultaInconclusiva(
      rotulo("A SEFAZ ainda não registra a NF-e, mas o envio é recente — consulte novamente em alguns minutos"),
      { cStat },
    );
  }
  if (cStat === 656) {
    return consultaInconclusiva(rotulo("Consumo indevido do serviço da SEFAZ — aguarde antes de consultar"), {
      cStat,
      retryAposMs: msPositivo(opcoes.consumoIndevidoCooldownMs, COOLDOWN_656_PADRAO_MS),
    });
  }
  return consultaInconclusiva(rotulo("Situação ainda indefinida na SEFAZ — consulte novamente em alguns minutos"), {
    cStat,
  });
}

// ─────────────────────────────── Focus ───────────────────────────────

const FOCUS_422_PRE_ENVIO = new Set(["permissao_negada", "erro_validacao_schema"]);
const FOCUS_422_EM_PROCESSAMENTO = new Set(["pending_operation", "em_processamento"]);
const FOCUS_422_JA_PROCESSADA = new Set(["already_processed", "nfe_autorizada"]);
const FOCUS_HTTP_PRE_ENVIO = new Set([400, 401, 403, 404, 415]);

function codigoFocus(corpo: FocusV2Corpo | null): string {
  return typeof corpo?.codigo === "string" ? corpo.codigo.trim().toLowerCase() : "";
}

function statusFocus(corpo: FocusV2Corpo | null): string {
  return typeof corpo?.status === "string" ? corpo.status.trim().toLowerCase() : "";
}

/** Motivo legível do Focus (mensagem SEFAZ, mensagem, até 3 erros de schema). */
function detalheFocus(corpo: FocusV2Corpo | null): string {
  if (!corpo) return "";
  const partes: string[] = [];
  const add = (v: unknown) => {
    const t = texto(v);
    if (t && !partes.includes(t)) partes.push(t);
  };
  add(corpo.mensagem_sefaz);
  add(corpo.mensagem);
  if (Array.isArray(corpo.erros)) {
    for (const e of corpo.erros.slice(0, 3)) {
      if (!e || typeof e !== "object") continue;
      const campo = texto(e.campo, 80);
      const msg = texto(e.mensagem);
      add(campo && msg ? `${campo}: ${msg}` : msg || campo);
    }
  }
  return texto(partes.join(" | "));
}

function protocoloFocus(corpo: FocusV2Corpo): string | null {
  if (temTexto(corpo.protocolo)) return corpo.protocolo as string;
  if (temTexto(corpo.protocolo_sefaz)) return corpo.protocolo_sefaz as string;
  return null;
}

function codigoProvedorFocus(corpo: FocusV2Corpo | null): string | null {
  if (!corpo) return null;
  return (
    codigoProvedorNaoNumerico(corpo.status_sefaz) ?? codigoProvedorNaoNumerico(corpo.codigo)
  );
}

const ACAO_FOCUS: Record<AcaoSeguimento, AcaoSeguimento> = {
  NENHUMA: "NENHUMA",
  CONSULTAR_CHAVE: "GET_REF",
  POLL_RECIBO: "POLL_REF",
  POLL_CHAVE: "POLL_REF",
  GET_REF: "GET_REF",
  POLL_REF: "POLL_REF",
  RECONCILIAR_539: "RECONCILIAR_539",
};

function incertoFocus(motivo: string, corpo: FocusV2Corpo | null = null): Classificacao {
  return montar({
    classe: "INCERTO_TRANSPORTE",
    acao: "GET_REF",
    codigoProvedor: codigoProvedorFocus(corpo),
    mensagem: `Envio ao Focus sem confirmação (${motivo}) — consultando a referência`,
  });
}

/**
 * Tabela A sobre o `status_sefaz` de um POST do Focus. As ações de consulta à
 * SEFAZ viram consulta à referência (o Focus é o canal de consulta). Um
 * "100" dentro de erro é contraditório ⇒ consulta a referência, nunca autoriza.
 */
function tabelaSefazNoPostFocus(
  cStat: number,
  corpo: FocusV2Corpo,
  opcoes: OpcoesClassificacao,
): Classificacao {
  const base = classificarCStatSefaz(
    cStat,
    { nProt: protocoloFocus(corpo), xMotivo: detalheFocus(corpo) },
    opcoes,
  );
  if (base.classe === "AUTORIZADA") {
    return montar({
      classe: "DESCONHECIDO",
      acao: "GET_REF",
      cStat,
      mensagem: comDetalhe(
        `Retorno contraditório do Focus (cStat ${cStat} em erro) — consultando a referência`,
        detalheFocus(corpo),
      ),
    });
  }
  return {
    ...base,
    acao: ACAO_FOCUS[base.acao],
    codigoProvedor: codigoProvedorFocus(corpo),
    // Chave lida do texto BRUTO (o detalhe da mensagem é truncado).
    chaveReferida:
      base.classe === "DUPLICIDADE_OUTRA_CHAVE" || base.classe === "DUPLICIDADE_MESMA_CHAVE"
        ? (extrairChaveReferida(corpo.mensagem_sefaz) ?? extrairChaveReferida(corpo.mensagem))
        : null,
  };
}

function preEnvioFocus(httpStatus: number, corpo: FocusV2Corpo | null): Classificacao {
  const codigo = codigoFocus(corpo);
  let base: string;
  if (httpStatus === 401) {
    base = "Token do Focus inválido para este ambiente (HTTP 401) — confira o token em Configurações fiscais";
  } else if (codigo === "permissao_negada") {
    base = "O token do Focus não tem permissão para emitir por esta empresa neste ambiente";
  } else if (codigo === "empresa_nao_habilitada") {
    base = "Empresa não habilitada no Focus para este ambiente";
  } else if (codigo === "erro_validacao_schema") {
    base = "Erro de validação no Focus";
  } else if (codigo === "requisicao_invalida") {
    base = "Requisição inválida para o Focus";
  } else if (httpStatus === 404) {
    base = "O Focus não encontrou o recurso (HTTP 404) — confira a empresa e o ambiente";
  } else {
    base = `O Focus recusou a requisição (HTTP ${httpStatus})`;
  }
  return montar({
    classe: "PRE_ENVIO_PROVEDOR",
    estadoAlvo: "RESERVADO",
    conclusiva: true,
    codigoProvedor: codigoProvedorFocus(corpo),
    mensagem: comDetalhe(base, detalheFocus(corpo)),
  });
}

/** Focus `POST /v2/{nfe|nfce}?ref=` (tabela C). */
export function classificarPostFocus(
  r: FocusV2Resposta,
  opcoes: OpcoesClassificacao = {},
): Classificacao {
  const corpo = r.corpo;
  if (r.transporte !== null) return incertoFocus(descreverTransporte(r.transporte));
  if (r.httpStatus === null) return incertoFocus("sem status HTTP");
  const s = r.httpStatus;

  if (s >= 500) return incertoFocus(`HTTP ${s}`, corpo);

  if (s >= 200 && s < 300) {
    if (!corpo) return incertoFocus(`HTTP ${s} com corpo ilegível`);
    const status = statusFocus(corpo);
    if (status === "autorizado") {
      if (!chave44(corpo.chave_nfe)) {
        return montar({
          classe: "AUTORIZADA",
          acao: "POLL_REF",
          mensagem: "Focus informou autorização sem chave legível — consultando a referência",
        });
      }
      return montar({
        classe: "AUTORIZADA",
        estadoAlvo: "AUTORIZADO",
        cStat: normalizarCStat(corpo.status_sefaz),
        mensagem: comDetalhe("NF-e autorizada", texto(corpo.mensagem_sefaz)),
      });
    }
    if (status === "erro_autorizacao") {
      const cStat = normalizarCStat(corpo.status_sefaz);
      if (cStat === null) {
        return montar({
          classe: "REJEICAO",
          estadoAlvo: "REJEITADO",
          conclusiva: true,
          codigoProvedor: codigoProvedorFocus(corpo),
          mensagem: comDetalhe("Rejeição informada pelo Focus", detalheFocus(corpo)),
        });
      }
      return tabelaSefazNoPostFocus(cStat, corpo, opcoes);
    }
    if (status === "denegado") {
      return montar({
        classe: "DENEGADA",
        estadoAlvo: "DENEGADO",
        cStat: normalizarCStat(corpo.status_sefaz),
        conclusiva: true,
        mensagem: comDetalhe("Uso denegado", detalheFocus(corpo)),
      });
    }
    if (status === "cancelado") {
      return montar({
        classe: "CANCELADA_NA_BASE",
        acao: "GET_REF",
        cStat: normalizarCStat(corpo.status_sefaz),
        mensagem: "Focus informou nota cancelada nesta referência — consultando a referência",
      });
    }
    // 202, processando_autorizacao, status ausente ou desconhecido.
    return montar({
      classe: "EM_PROCESSAMENTO",
      acao: "POLL_REF",
      mensagem: "NF-e em processamento no Focus — acompanhando a referência",
    });
  }

  if (s === 429) {
    return montar({
      classe: "RATE_LIMIT",
      estadoAlvo: "RESERVADO",
      conclusiva: true,
      retryAposMs: msPositivo(r.retryAfterMs, msPositivo(opcoes.rateLimitPadraoMs, RATE_LIMIT_PADRAO_MS)),
      codigoProvedor: codigoProvedorFocus(corpo),
      mensagem: "Limite de requisições do Focus atingido — aguarde e tente novamente",
    });
  }

  if (s === 422) {
    if (!corpo) return incertoFocus("HTTP 422 com corpo ilegível");
    const codigo = codigoFocus(corpo);
    if (FOCUS_422_PRE_ENVIO.has(codigo)) return preEnvioFocus(s, corpo);
    if (FOCUS_422_EM_PROCESSAMENTO.has(codigo)) {
      return montar({
        classe: "EM_PROCESSAMENTO",
        acao: "GET_REF",
        codigoProvedor: codigoProvedorFocus(corpo),
        mensagem: "Já existe operação em andamento nesta referência no Focus — consultando a referência",
      });
    }
    if (FOCUS_422_JA_PROCESSADA.has(codigo)) {
      return montar({
        classe: "DUPLICIDADE_MESMA_CHAVE",
        acao: "GET_REF",
        codigoProvedor: codigoProvedorFocus(corpo),
        mensagem: "Referência já processada no Focus — consultando a referência",
      });
    }
    const cStat = normalizarCStat(corpo.status_sefaz);
    if (cStat !== null) return tabelaSefazNoPostFocus(cStat, corpo, opcoes);
    // Código 422 desconhecido: o POST foi recusado (conclusivo), mas a
    // referência pode existir de antes ⇒ confirma pelo GET (404 vale na hora).
    return montar({
      classe: "DESCONHECIDO",
      acao: "GET_REF",
      conclusiva: true,
      codigoProvedor: codigoProvedorFocus(corpo),
      mensagem: comDetalhe("Recusa não reconhecida do Focus (HTTP 422) — consultando a referência", detalheFocus(corpo)),
    });
  }

  if (FOCUS_HTTP_PRE_ENVIO.has(s)) return preEnvioFocus(s, corpo);

  // 1xx/3xx, 408, 409 e demais 4xx: sem prova de que nada foi aceito.
  return incertoFocus(`HTTP ${s}`, corpo);
}

/**
 * Tabela D: `erro_autorizacao` num GET. O GET já É a consulta, então códigos
 * que na tabela A pedem consulta decidem aqui: 205 ⇒ consumido; 204/218 ⇒
 * conferência manual (nunca reuso às cegas de número que a SEFAZ diz existir).
 */
function tabelaSefazNoGetFocus(
  corpo: FocusV2Corpo,
  opcoes: OpcoesClassificacao,
): Classificacao {
  const cStat = normalizarCStat(corpo.status_sefaz);
  const detalhe = detalheFocus(corpo);
  const codigoProvedor = codigoProvedorFocus(corpo);
  const rotulo = (base: string) =>
    comDetalhe(cStat === null ? base : `${base} (cStat ${cStat})`, detalhe);
  const decidido = (
    classe: ClasseResultado,
    estadoAlvo: EstadoReserva,
    mensagem: string,
    extra: Partial<Classificacao> = {},
  ) => montar({ classe, estadoAlvo, cStat, codigoProvedor, mensagem, ...extra });

  if (cStat === null || cStat < 100) {
    return decidido("REJEICAO", "REJEITADO", rotulo("Rejeição informada pelo Focus"), {
      conclusiva: true,
    });
  }
  if (DUPLICIDADE_OUTRA_CHAVE.has(cStat)) {
    return montar({
      classe: "DUPLICIDADE_OUTRA_CHAVE",
      acao: "RECONCILIAR_539",
      cStat,
      codigoProvedor,
      conclusiva: true,
      chaveReferida: extrairChaveReferida(corpo.mensagem_sefaz) ?? extrairChaveReferida(corpo.mensagem),
      mensagem: rotulo("Número já usado por outra chave — conferindo as chaves das tentativas"),
    });
  }
  if (cStat === 205) {
    return decidido("DENEGADA_NA_BASE", "CONSUMIDO_EXTERNO", rotulo("Número já denegado na base da SEFAZ"), {
      conclusiva: true,
    });
  }
  if (cStat === 206) {
    return decidido("INUTILIZADA_NA_BASE", "INUTILIZADO", rotulo("Número já inutilizado na SEFAZ"), {
      conclusiva: true,
    });
  }
  if (SERVICO_INDISPONIVEL.has(cStat)) {
    return decidido("SERVICO_INDISPONIVEL", "RESERVADO", rotulo("SEFAZ indisponível — tente novamente mais tarde"), {
      conclusiva: true,
    });
  }
  if (cStat === 635) {
    return decidido(
      "EM_PROCESSAMENTO_NA_SEFAZ",
      "INCERTO",
      rotulo("NF-e com o mesmo número e série aguardando processamento na SEFAZ — use Consultar situação"),
    );
  }
  if (cStat === 656) {
    return decidido("CONSUMO_INDEVIDO", "REJEITADO", rotulo("Consumo indevido do serviço da SEFAZ — aguarde antes de reenviar"), {
      conclusiva: true,
      retryAposMs: msPositivo(opcoes.consumoIndevidoCooldownMs, COOLDOWN_656_PADRAO_MS),
    });
  }
  if (DENEGACAO.has(cStat)) {
    if (protocoloFocus(corpo)) {
      return decidido("DENEGADA", "DENEGADO", rotulo("Uso denegado"), { conclusiva: true });
    }
    // Sem protocolo não há prova de denegação; o reenvio do mesmo número
    // devolve 205 se ela de fato existir (⇒ CONSUMIDO_EXTERNO).
    return decidido("REJEICAO", "REJEITADO", rotulo("Rejeição informada pelo Focus"), { conclusiva: true });
  }
  if (cStat === 204) {
    return decidido(
      "DUPLICIDADE_MESMA_CHAVE",
      "BLOQUEADO",
      rotulo("Focus informou duplicidade da NF-e — conferência manual"),
    );
  }
  if (cStat === 218) {
    return decidido(
      "CANCELADA_NA_BASE",
      "BLOQUEADO",
      rotulo("Focus informou NF-e já cancelada na SEFAZ — conferência manual"),
    );
  }
  if (cStat < 200) {
    return montar({
      classe: "CONSULTA_INCONCLUSIVA",
      estadoAlvo: "INCERTO",
      cStat,
      codigoProvedor,
      mensagem: rotulo("Retorno contraditório do Focus — consulte novamente em alguns minutos"),
    });
  }
  return decidido("REJEICAO", "REJEITADO", rotulo("Rejeição"), { conclusiva: true });
}

/** Focus `GET /v2/{nfe|nfce}/{ref}` (tabela D). Só 404 maduro vale "não consta". */
export function classificarGetFocus(
  r: FocusV2Resposta,
  ctx: { madura: boolean; postConclusivo: boolean },
  opcoes: OpcoesClassificacao = {},
): Classificacao {
  const corpo = r.corpo;
  const inconclusiva = (mensagem: string, extra: Partial<Classificacao> = {}) =>
    consultaInconclusiva(mensagem, { codigoProvedor: codigoProvedorFocus(corpo), ...extra });

  if (r.transporte !== null) {
    return inconclusiva(
      `Consulta ao Focus sem resposta (${descreverTransporte(r.transporte)}) — tente novamente em alguns minutos`,
    );
  }
  if (r.httpStatus === null) {
    return inconclusiva("Consulta ao Focus sem status HTTP — tente novamente em alguns minutos");
  }
  const s = r.httpStatus;

  if (s === 404) {
    const codigo = codigoFocus(corpo);
    if (!corpo || (codigo !== "" && codigo !== "nao_encontrado")) {
      return inconclusiva("Consulta ao Focus devolveu HTTP 404 sem confirmação da referência — tente novamente");
    }
    if (ctx.madura || ctx.postConclusivo) {
      return montar({
        classe: "NAO_CONSTA",
        estadoAlvo: "RESERVADO",
        conclusiva: true,
        codigoProvedor: codigoProvedorFocus(corpo),
        mensagem: "Envio não registrado no Focus",
      });
    }
    return inconclusiva(
      "O Focus ainda não registra a referência, mas o envio é recente — consulte novamente em alguns minutos",
    );
  }
  if (s === 429) {
    return inconclusiva("Limite de requisições do Focus atingido na consulta — aguarde e consulte novamente", {
      retryAposMs: msPositivo(r.retryAfterMs, msPositivo(opcoes.rateLimitPadraoMs, RATE_LIMIT_PADRAO_MS)),
    });
  }
  if (s < 200 || s >= 300) {
    return inconclusiva(`Consulta ao Focus respondeu HTTP ${s} — tente novamente em alguns minutos`);
  }
  if (!corpo) {
    return inconclusiva("Consulta ao Focus com corpo ilegível — tente novamente em alguns minutos");
  }

  const status = statusFocus(corpo);
  if (status === "autorizado") {
    if (!chave44(corpo.chave_nfe)) {
      return inconclusiva("Focus informou autorização sem chave legível — consulte novamente");
    }
    return montar({
      classe: "AUTORIZADA",
      estadoAlvo: "AUTORIZADO",
      cStat: normalizarCStat(corpo.status_sefaz),
      mensagem: comDetalhe("NF-e autorizada (confirmada por consulta)", texto(corpo.mensagem_sefaz)),
    });
  }
  if (status === "cancelado") {
    return montar({
      classe: "CANCELADA_FORA_DO_FLUXO",
      estadoAlvo: "BLOQUEADO",
      cStat: normalizarCStat(corpo.status_sefaz),
      mensagem: "NF-e cancelada no Focus fora do fluxo de emissão — conferência manual",
    });
  }
  if (status === "denegado") {
    return montar({
      classe: "DENEGADA",
      estadoAlvo: "DENEGADO",
      cStat: normalizarCStat(corpo.status_sefaz),
      conclusiva: true,
      mensagem: comDetalhe("Uso denegado (confirmado por consulta)", detalheFocus(corpo)),
    });
  }
  if (status === "erro_autorizacao") return tabelaSefazNoGetFocus(corpo, opcoes);

  return inconclusiva("NF-e ainda em processamento no Focus — consulte novamente em alguns minutos");
}
