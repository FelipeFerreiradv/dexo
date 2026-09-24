/**
 * Numeração V2 — decisões PURAS do orquestrador (sem banco, sem rede, sem env).
 *
 *  - `decidirEntrada`: portão de status da emissão (design §4.9, E1).
 *  - `decidirPreClaim`: confirmação de descarte e cooldown L1 (E3, §4.18).
 *  - `decidirAdocaoLegado`: adotar o número de uma linha V1 na mesma linha, só
 *    com evidência (§4.5). Linha da Focus nunca é adotada.
 *  - `decidirReadbackFocus`: nº/série REAIS lidos da chave autorizada (§4.7).
 *  - `avaliarFaixa`: guarda da inutilização V2 (§4.15).
 *  - `hashConteudo`: impressão digital do conteúdo do rascunho (L1).
 *
 * Só do servidor: `hashConteudo` usa `node:crypto`. Nada daqui vai para o client.
 */

import { createHash } from "node:crypto";

import type { ClasseResultado, EstadoReserva } from "./tipos";
import { ESTADOS_REUSAVEIS } from "./tipos";
import { classificarCStatSefaz } from "./classificacao";
import { normalizarCStat } from "./cstat";

function ms(d: unknown): number {
  return d instanceof Date ? d.getTime() : NaN;
}

function reusavel(estado: unknown): boolean {
  return (ESTADOS_REUSAVEIS as readonly string[]).includes(String(estado));
}

// ─────────────────────────────── decidirEntrada ───────────────────────────────

export type AcaoEntrada =
  | "REPLAY_AUTORIZADA"
  | "DELEGAR_V1"
  | "EM_ANDAMENTO"
  | "BLOQUEADA_MANUAL"
  | "RECONCILIAR"
  | "RETOMAR_TRAVADA"
  | "SEGUIR";

export interface ReservaVivaEntrada {
  estado: EstadoReserva | string;
  leaseAte: Date | null;
  numero: number;
}

export interface EntradaDecisao {
  /** `NfeEmitida.status` atual. */
  status: string;
  /** `NfeEmitida.updatedAt` (idade da trava pré-envio). */
  updatedAt: Date;
  viva: ReservaVivaEntrada | null;
  agora: Date;
  leasePreEnvioMs: number;
  /** `NfeEmitida.numero` (placeholder negativo = nunca numerada). */
  numero?: number;
}

export interface DecisaoEntrada {
  acao: AcaoEntrada;
  mensagem: string;
}

/** SENDING sem reserva V2: linha legada (decisão 3 — nenhuma ação automática). */
export const MENSAGEM_SENDING_LEGADO = "emissão anterior à numeração v2 — sem ação automática";
export const MENSAGEM_EM_ANDAMENTO = "Emissão desta NF-e já está em andamento";

const TRANSMISSAO_ABERTA = new Set(["EM_TRANSMISSAO", "INCERTO"]);
const CONSUMO_REGISTRADO = new Set(["AUTORIZADO", "CANCELADO"]);

function leaseValido(viva: ReservaVivaEntrada, agora: Date): boolean {
  const ate = ms(viva.leaseAte);
  const t = ms(agora);
  // Expirado ⇔ leaseAte < agora (mesma régua do SQL `"leaseAte" < NOW()`).
  return Number.isFinite(ate) && Number.isFinite(t) && ate >= t;
}

/** Decisão para reserva EM_TRANSMISSAO/INCERTO: lease válido espera; senão consulta. */
function decidirTransmissaoAberta(viva: ReservaVivaEntrada, agora: Date): DecisaoEntrada {
  if (viva.estado === "EM_TRANSMISSAO" && leaseValido(viva, agora)) {
    return { acao: "EM_ANDAMENTO", mensagem: MENSAGEM_EM_ANDAMENTO };
  }
  return {
    acao: "RECONCILIAR",
    mensagem: "Envio anterior sem confirmação — consultando a situação antes de qualquer reenvio",
  };
}

function bloqueadaManual(numero: number): DecisaoEntrada {
  return {
    acao: "BLOQUEADA_MANUAL",
    mensagem: `Numeração nº ${numero} exige conferência manual`,
  };
}

export function decidirEntrada(e: EntradaDecisao): DecisaoEntrada {
  const { status, viva, agora } = e;

  if (status === "AUTHORIZED") return { acao: "REPLAY_AUTORIZADA", mensagem: "NF-e já autorizada" };
  if (status === "CANCELLED" || status === "INUTILIZED") {
    return { acao: "DELEGAR_V1", mensagem: "" };
  }
  if (viva && viva.estado === "BLOQUEADO") return bloqueadaManual(viva.numero);

  if (status === "DRAFT" || status === "REJECTED") {
    if (!viva || reusavel(viva.estado)) return { acao: "SEGUIR", mensagem: "" };
    // Só acontece após SQL manual: nunca reenviar sem consultar antes.
    if (TRANSMISSAO_ABERTA.has(viva.estado)) {
      return {
        acao: "RECONCILIAR",
        mensagem: "Envio anterior sem confirmação — consultando a situação antes de qualquer reenvio",
      };
    }
    // Número já consumido por autorização com a linha fora de AUTHORIZED: anomalia.
    if (CONSUMO_REGISTRADO.has(viva.estado)) return bloqueadaManual(viva.numero);
    // DENEGADO/INUTILIZADO/CONSUMIDO_EXTERNO/ABANDONADO: a reserva seguinte decide (número novo).
    return { acao: "SEGUIR", mensagem: "" };
  }

  if (status === "VALIDATING" || status === "SIGNING") {
    if (viva && reusavel(viva.estado)) {
      const idade = ms(agora) - ms(e.updatedAt);
      // Mesma régua do SQL de retomada: `"updatedAt" < agora - lease` (estritamente mais velho).
      if (Number.isFinite(idade) && idade > e.leasePreEnvioMs) {
        return {
          acao: "RETOMAR_TRAVADA",
          mensagem: `Emissão travada antes do envio — retomando com o mesmo nº ${viva.numero}`,
        };
      }
      return { acao: "EM_ANDAMENTO", mensagem: MENSAGEM_EM_ANDAMENTO };
    }
    if (viva && TRANSMISSAO_ABERTA.has(viva.estado)) return decidirTransmissaoAberta(viva, agora);
    if (viva && CONSUMO_REGISTRADO.has(viva.estado)) return bloqueadaManual(viva.numero);
    // Sem reserva e nunca numerada (queda entre o claim e a reserva): nada foi transmitido,
    // então, passado o lease, retoma. Linha antiga numerada (V1) continua intocada (decisão 3).
    if (!viva && typeof e.numero === "number" && e.numero <= 0) {
      const idade = ms(agora) - ms(e.updatedAt);
      if (Number.isFinite(idade) && idade > e.leasePreEnvioMs) {
        return { acao: "RETOMAR_TRAVADA", mensagem: "Emissão travada antes do envio — retomando" };
      }
    }
    // Sem reserva: vencedor entre o claim e a reserva, ou linha antiga travada (decisão 3).
    return { acao: "EM_ANDAMENTO", mensagem: MENSAGEM_EM_ANDAMENTO };
  }

  if (status === "SENDING") {
    if (viva && TRANSMISSAO_ABERTA.has(viva.estado)) return decidirTransmissaoAberta(viva, agora);
    if (viva && CONSUMO_REGISTRADO.has(viva.estado)) return bloqueadaManual(viva.numero);
    // Sem reserva viva em transmissão: envio do fluxo anterior (V1).
    return { acao: "EM_ANDAMENTO", mensagem: MENSAGEM_SENDING_LEGADO };
  }

  // Status desconhecido: o V1 devolve o erro de sempre.
  return { acao: "DELEGAR_V1", mensagem: "" };
}

// ─────────────────────────────── decidirPreClaim ───────────────────────────────

/** Chave fiscal K = (emitente, ambiente, modelo, série). */
export interface ChaveFiscal {
  cfc: string;
  ambiente: string;
  modelo: string;
  serie: number;
}

export interface ReservaPreClaim {
  estado: EstadoReserva | string;
  numero: number;
  serie: number;
  ambiente: string;
  modelo: string;
  companyFiscalConfigId: string;
  bloqueadoAte?: Date | null;
}

export interface TentativaPreClaim {
  conteudoSha256: string | null;
  classe: ClasseResultado | string | null;
  transmitidaEm: Date;
  respondidaEm?: Date | null;
}

export type MotivoTrocaChave = "EMITENTE" | "AMBIENTE" | "MODELO" | "SERIE";

export type DecisaoPreClaim =
  | { acao: "SEGUIR"; troca: MotivoTrocaChave | null }
  | {
      acao: "CONFIRMAR_DESCARTE";
      mensagem: string;
      detalhes: { numero: number; serie: number; motivo: MotivoTrocaChave };
    }
  | { acao: "COOLDOWN"; mensagem: string; retryAposMs: number; numero: number };

/** Primeira dimensão da chave fiscal que mudou (null = mesma chave). */
export function motivoTrocaChave(
  reserva: Pick<ReservaPreClaim, "companyFiscalConfigId" | "ambiente" | "modelo" | "serie">,
  key: ChaveFiscal,
): MotivoTrocaChave | null {
  if (reserva.companyFiscalConfigId !== key.cfc) return "EMITENTE";
  if (reserva.ambiente !== key.ambiente) return "AMBIENTE";
  if (String(reserva.modelo) !== String(key.modelo)) return "MODELO";
  if (Number(reserva.serie) !== Number(key.serie)) return "SERIE";
  return null;
}

/** Classes que, repetidas com o MESMO conteúdo, só voltariam a ser recusadas. */
const CLASSES_COOLDOWN_REPETICAO = new Set<string>(["REJEICAO", "PRE_ENVIO_PROVEDOR"]);

function formatarEspera(esperaMs: number): string {
  const s = Math.max(1, Math.ceil(esperaMs / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.ceil(s / 60)} min`;
}

export function decidirPreClaim(e: {
  viva: ReservaPreClaim | null;
  key: ChaveFiscal;
  conteudoSha256: string;
  ultimaTentativa: TentativaPreClaim | null;
  confirmarDescarte: boolean;
  agora: Date;
  cooldownMs: number;
}): DecisaoPreClaim {
  const { viva } = e;
  // Sem reserva, ou reserva não reusável (E1 já tratou transmissão/bloqueio).
  if (!viva || !reusavel(viva.estado)) return { acao: "SEGUIR", troca: null };

  const troca = motivoTrocaChave(viva, e.key);
  if (troca) {
    if (viva.ambiente === "PRODUCAO" && e.confirmarDescarte !== true) {
      return {
        acao: "CONFIRMAR_DESCARTE",
        mensagem: `O nº ${viva.numero} (série ${viva.serie}) ficará sem uso e precisará ser inutilizado`,
        detalhes: { numero: viva.numero, serie: viva.serie, motivo: troca },
      };
    }
    // Homologação, ou produção confirmada: o número antigo é abandonado na reserva.
    return { acao: "SEGUIR", troca };
  }

  const agora = ms(e.agora);
  const bloqueadoAte = ms(viva.bloqueadoAte);
  if (Number.isFinite(bloqueadoAte) && Number.isFinite(agora) && bloqueadoAte > agora) {
    const espera = bloqueadoAte - agora;
    return {
      acao: "COOLDOWN",
      retryAposMs: espera,
      numero: viva.numero,
      mensagem: `Reenvio temporariamente bloqueado — tente novamente em ${formatarEspera(espera)}; o nº ${viva.numero} continua desta nota`,
    };
  }

  const t = e.ultimaTentativa;
  if (
    t &&
    t.classe !== null &&
    CLASSES_COOLDOWN_REPETICAO.has(String(t.classe)) &&
    typeof t.conteudoSha256 === "string" &&
    t.conteudoSha256 === e.conteudoSha256 &&
    Number.isFinite(e.cooldownMs) &&
    e.cooldownMs > 0
  ) {
    const referencia = Number.isFinite(ms(t.respondidaEm)) ? ms(t.respondidaEm) : ms(t.transmitidaEm);
    const decorrido = agora - referencia;
    if (Number.isFinite(decorrido) && decorrido < e.cooldownMs) {
      const espera = Math.max(1, e.cooldownMs - Math.max(0, decorrido));
      return {
        acao: "COOLDOWN",
        retryAposMs: espera,
        numero: viva.numero,
        mensagem: `A mesma nota acabou de ser recusada — corrija os dados ou aguarde ${formatarEspera(espera)} para reenviar; o nº ${viva.numero} continua desta nota`,
      };
    }
  }

  return { acao: "SEGUIR", troca: null };
}

// ─────────────────────────────── decidirAdocaoLegado ───────────────────────────────

/** Evento de `NfeAuditLog` (ordem cronológica; `createdAt` reordena quando presente em todos). */
export interface EventoTrilha {
  evento: string;
  detalhes?: unknown;
  createdAt?: Date | null;
}

export type MotivoRecusaAdocao =
  | "FOCUS_NUMERO_FICTICIO"
  | "SEM_NUMERO"
  | "STATUS_INELEGIVEL"
  | "NUMERO_NAO_ABAIXO_DO_CONTADOR"
  | "NUMERO_INUTILIZADO"
  | "NUMERO_RESERVADO"
  | "NUMERO_EM_OUTRA_NOTA"
  | "SEM_TRILHA"
  | "TRILHA_INCERTA"
  | "SEM_EVIDENCIA";

export type DecisaoAdocaoLegado =
  | {
      adotar: true;
      estado: "RESERVADO" | "REJEITADO";
      evidencia: "NUNCA_TRANSMITIDO" | "REJEICAO_SEFAZ";
    }
  | { adotar: false; motivo: MotivoRecusaAdocao };

export interface EntradaAdocaoLegado {
  row: {
    numero: number;
    serie: number;
    status: string;
    cStatRejeicao: number | null | undefined;
  };
  providerName: string | null;
  trilha: readonly EventoTrilha[] | null;
  proximoNumero: number;
  ocupacao: { inutilizado: boolean; reservado: boolean; emNota?: boolean };
}

function detalhesDe(ev: EventoTrilha): Record<string, unknown> {
  return ev.detalhes && typeof ev.detalhes === "object" && !Array.isArray(ev.detalhes)
    ? (ev.detalhes as Record<string, unknown>)
    : {};
}

function ordenarTrilha(trilha: readonly EventoTrilha[]): EventoTrilha[] {
  const copia = trilha.map((ev, i) => ({ ev, i }));
  const todasDatadas = copia.every(({ ev }) => Number.isFinite(ms(ev.createdAt)));
  if (todasDatadas) {
    copia.sort((a, b) => ms(a.ev.createdAt) - ms(b.ev.createdAt) || a.i - b.i);
  }
  return copia.map(({ ev }) => ev);
}

const EVENTOS_TRILHA_INCERTA = new Set(["ENVIO_INCERTO", "AUTORIZADA", "NUMERADA"]);

export function decidirAdocaoLegado(e: EntradaAdocaoLegado): DecisaoAdocaoLegado {
  const recusa = (motivo: MotivoRecusaAdocao): DecisaoAdocaoLegado => ({ adotar: false, motivo });
  const { row } = e;

  // `numero_nota` era ignorado pela Focus: o número da linha não é o nNF real.
  if (e.providerName !== "SEFAZ_DIRECT") return recusa("FOCUS_NUMERO_FICTICIO");
  if (!Number.isInteger(row.numero) || row.numero <= 0) return recusa("SEM_NUMERO");
  if (row.status !== "DRAFT" && row.status !== "REJECTED") return recusa("STATUS_INELEGIVEL");
  if (!Number.isFinite(e.proximoNumero) || row.numero >= e.proximoNumero) {
    return recusa("NUMERO_NAO_ABAIXO_DO_CONTADOR");
  }
  if (e.ocupacao.inutilizado) return recusa("NUMERO_INUTILIZADO");
  if (e.ocupacao.reservado) return recusa("NUMERO_RESERVADO");
  if (e.ocupacao.emNota === true) return recusa("NUMERO_EM_OUTRA_NOTA");

  const trilha = ordenarTrilha(e.trilha ?? []);
  let ultimaNumerada = -1;
  trilha.forEach((ev, i) => {
    if (ev.evento !== "NUMERADA") return;
    const d = detalhesDe(ev);
    if (Number(d.numero) === row.numero && Number(d.serie) === row.serie) ultimaNumerada = i;
  });
  if (ultimaNumerada < 0) return recusa("SEM_TRILHA");

  const depois = trilha.slice(ultimaNumerada + 1);
  const incerta = depois.some(
    (ev) => EVENTOS_TRILHA_INCERTA.has(ev.evento) || ev.evento.startsWith("CONTINGENCIA"),
  );
  if (incerta) return recusa("TRILHA_INCERTA");

  const indiceUltimoEnvio = depois.map((ev) => ev.evento).lastIndexOf("ENVIADA");

  // Evidência A: erro local antes do envio e nenhum envio depois da numeração.
  if (indiceUltimoEnvio < 0) {
    const erroLocal = depois.some((ev) => {
      if (ev.evento !== "EDITADA_DRAFT") return false;
      const motivo = detalhesDe(ev).motivo;
      return typeof motivo === "string" && motivo.startsWith("Erro antes do envio");
    });
    return erroLocal
      ? { adotar: true, estado: "RESERVADO", evidencia: "NUNCA_TRANSMITIDO" }
      : recusa("SEM_EVIDENCIA");
  }

  // Evidência B: o último envio foi SEFAZ direto e terminou em rejeição comum.
  const ultimoEnvio = depois[indiceUltimoEnvio];
  const rejeitadaDepois = depois
    .slice(indiceUltimoEnvio + 1)
    .some((ev) => ev.evento === "REJEITADA");
  const cStat = normalizarCStat(row.cStatRejeicao);
  if (
    detalhesDe(ultimoEnvio).providerName === "SEFAZ_DIRECT" &&
    rejeitadaDepois &&
    cStat !== null &&
    classificarCStatSefaz(cStat, { nProt: null }).estadoAlvo === "REJEITADO"
  ) {
    return { adotar: true, estado: "REJEITADO", evidencia: "REJEICAO_SEFAZ" };
  }
  return recusa("SEM_EVIDENCIA");
}

// ─────────────────────────────── decidirReadbackFocus ───────────────────────────────

export interface PartesChaveAcesso {
  cUF: string;
  AAMM: string;
  CNPJ: string;
  mod: string;
  serie: string;
  nNF: string;
  tpEmis: string;
  cNF: string;
  cDV: string;
}

function dvChave(base43: string): string {
  let soma = 0;
  let peso = 2;
  for (let i = base43.length - 1; i >= 0; i--) {
    soma += Number(base43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const dv = 11 - (soma % 11);
  return dv >= 10 ? "0" : String(dv);
}

/**
 * Partes da chave de acesso (44 dígitos, DV módulo 11 conferido). Aceita o
 * prefixo "NFe" (é descartado com os demais não dígitos). Inválida ⇒ null.
 * Local de propósito: `chave-acesso.ts` importa `node:crypto`.
 */
export function partesDaChave(chave: unknown): PartesChaveAcesso | null {
  if (typeof chave !== "string") return null;
  const d = chave.replace(/\D/g, "");
  if (d.length !== 44) return null;
  if (dvChave(d.slice(0, 43)) !== d.slice(43, 44)) return null;
  return {
    cUF: d.slice(0, 2),
    AAMM: d.slice(2, 6),
    CNPJ: d.slice(6, 20),
    mod: d.slice(20, 22),
    serie: d.slice(22, 25),
    nNF: d.slice(25, 34),
    tpEmis: d.slice(34, 35),
    cNF: d.slice(35, 43),
    cDV: d.slice(43, 44),
  };
}

/**
 * CNPJ do emitente na forma EXATA em que a chave de acesso o carrega (posições
 * 7-20): só dígitos e, quando o emitente é pessoa física, `000` + CPF. Qualquer
 * outra coisa ⇒ null (ausente/ilegível — quem compara decide o que fazer).
 */
export function cnpjNaChave(valor: unknown): string | null {
  const d = typeof valor === "string" ? valor.replace(/\D/g, "") : "";
  const cnpj = d.length === 11 ? d.padStart(14, "0") : d; // emitente CPF: chave usa 000+CPF
  return cnpj.length === 14 ? cnpj : null;
}

export type DecisaoReadbackFocus =
  | { resultado: "IGUAL"; numero: number; serie: number }
  | { resultado: "DIVERGENTE"; numero: number; serie: number }
  | {
      resultado: "INCONSISTENTE";
      motivo: "CHAVE_INVALIDA" | "CNPJ_DIVERGENTE" | "MODELO_DIVERGENTE";
    };

export function decidirReadbackFocus(e: {
  reservado: { numero: number; serie: number };
  chave44: string | null;
  cnpjConfig: string | null;
  modelo: "55" | "65";
}): DecisaoReadbackFocus {
  const partes = partesDaChave(e.chave44);
  const numero = partes ? Number(partes.nNF) : NaN;
  if (!partes || !(numero >= 1)) return { resultado: "INCONSISTENTE", motivo: "CHAVE_INVALIDA" };

  const cnpj = cnpjNaChave(e.cnpjConfig);
  if (cnpj === null || cnpj !== partes.CNPJ) {
    return { resultado: "INCONSISTENTE", motivo: "CNPJ_DIVERGENTE" };
  }
  if (partes.mod !== e.modelo) return { resultado: "INCONSISTENTE", motivo: "MODELO_DIVERGENTE" };

  const serie = Number(partes.serie);
  if (numero === e.reservado.numero && serie === Number(e.reservado.serie)) {
    return { resultado: "IGUAL", numero, serie };
  }
  return { resultado: "DIVERGENTE", numero, serie };
}

// ─────────────────────────────── avaliarFaixa ───────────────────────────────

export interface BloqueioFaixa {
  numero: number;
  motivo: string;
  /** Presente quando o bloqueio vem de uma NF-e (linha). */
  nfeId?: string;
}

function motivoLinha(numero: number, id: string, status: string): string {
  switch (status) {
    case "AUTHORIZED":
      return `nº ${numero} já está em NF-e autorizada (${id})`;
    case "CANCELLED":
      return `nº ${numero} pertence a NF-e cancelada (${id})`;
    case "SENDING":
    case "VALIDATING":
    case "SIGNING":
      return `nº ${numero} está em emissão (${id})`;
    case "DRAFT":
    case "REJECTED":
      return `nº ${numero} está no rascunho ${id} — exclua o rascunho antes de inutilizar`;
    default:
      return `nº ${numero} está em uso (${id}, situação ${status})`;
  }
}

/**
 * Guarda da inutilização V2: bloqueia a faixa quando algum número está numa
 * NF-e (qualquer situação exceto INUTILIZED) ou numa reserva que não seja
 * ABANDONADO. Linhas e reservas fora de [ini, fim] são ignoradas.
 */
export function avaliarFaixa(e: {
  linhas: ReadonlyArray<{ id: string; numero: number; status: string }>;
  reservas: ReadonlyArray<{ numero: number; estado: string }>;
  ini: number;
  fim: number;
}): { ok: boolean; bloqueios: BloqueioFaixa[] } {
  const { ini, fim } = e;
  if (!Number.isInteger(ini) || !Number.isInteger(fim) || ini < 1 || fim < ini) {
    return {
      ok: false,
      bloqueios: [{ numero: Number.isInteger(ini) ? ini : 0, motivo: "Faixa de numeração inválida" }],
    };
  }
  const dentro = (n: number) => Number.isInteger(n) && n >= ini && n <= fim;
  const bloqueios: BloqueioFaixa[] = [];

  for (const l of e.linhas) {
    if (!dentro(l.numero) || l.status === "INUTILIZED") continue;
    bloqueios.push({ numero: l.numero, nfeId: l.id, motivo: motivoLinha(l.numero, l.id, l.status) });
  }
  for (const r of e.reservas) {
    if (!dentro(r.numero) || r.estado === "ABANDONADO") continue;
    bloqueios.push({
      numero: r.numero,
      motivo: `nº ${r.numero} tem reserva de numeração em ${r.estado}`,
    });
  }
  bloqueios.sort((a, b) => a.numero - b.numero);
  return { ok: bloqueios.length === 0, bloqueios };
}

/** Texto único para o erro da faixa: até `max` bloqueios e a contagem do resto. */
export function mensagemBloqueiosFaixa(bloqueios: readonly BloqueioFaixa[], max = 10): string {
  const limite = Math.max(1, Math.floor(max));
  const listados = bloqueios.slice(0, limite).map((b) => b.motivo);
  const resto = bloqueios.length - listados.length;
  const base = listados.join("; ");
  return resto > 0 ? `${base}; e mais ${resto}` : base;
}

// ─────────────────────────────── hashConteudo ───────────────────────────────

/** Chaves que mudam a cada tentativa/salvamento sem mudar o conteúdo fiscal. */
export const CHAVES_IGNORADAS_HASH: ReadonlySet<string> = new Set([
  "id",
  "status",
  "numero",
  "chaveAcesso",
  "createdAt",
  "updatedAt",
  "dataEmissao",
  "motivoRejeicao",
  "cStatRejeicao",
]);

/** JSON canônico: chaves ordenadas, chaves ignoradas em QUALQUER profundidade. */
function serializarEstavel(valor: unknown, ancestrais: Set<object>): string | undefined {
  if (valor === null) return "null";
  switch (typeof valor) {
    case "string":
      return JSON.stringify(valor);
    case "number":
      return Number.isFinite(valor) ? JSON.stringify(valor) : "null";
    case "boolean":
      return valor ? "true" : "false";
    case "bigint":
      return JSON.stringify(valor.toString());
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  const obj = valor as object;
  if (ancestrais.has(obj)) return JSON.stringify("[Circular]");
  ancestrais.add(obj);
  try {
    const toJSON = (obj as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      // Date, Decimal do Prisma, Buffer: a mesma forma que o JSON.stringify usaria.
      return serializarEstavel((toJSON as () => unknown).call(obj), ancestrais);
    }
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => serializarEstavel(item, ancestrais) ?? "null").join(",")}]`;
    }
    const partes: string[] = [];
    for (const k of Object.keys(obj).sort()) {
      if (CHAVES_IGNORADAS_HASH.has(k)) continue;
      const s = serializarEstavel((obj as Record<string, unknown>)[k], ancestrais);
      if (s !== undefined) partes.push(`${JSON.stringify(k)}:${s}`);
    }
    return `{${partes.join(",")}}`;
  } finally {
    ancestrais.delete(obj);
  }
}

/** sha256 (hex, 64) do conteúdo do rascunho, estável a ordem de chaves e a ids/timestamps. */
export function hashConteudo(draft: unknown): string {
  const canonico = serializarEstavel(draft, new Set()) ?? "null";
  return createHash("sha256").update(canonico, "utf8").digest("hex");
}
