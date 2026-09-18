/**
 * Responsável técnico (grupo `infRespTec`, NT 2018.005) POR EMPRESA — regras puras.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 * Até aqui o RT vinha só da env global `NFE_RESP_TEC_*`, igual para todos os
 * tenants do SEFAZ direto, e o Focus preenchia o dele. A SEFAZ de algumas UFs
 * confere o RT contra o que a EMPRESA autorizou (PR: regra 7ZD02-10, rejeição
 * 974, UPD da Receita PR) e exige o CSRT em produção (PR desde 01/04/2026,
 * rejeição 975). Uma configuração que a SEFAZ rejeitaria em TODA emissão não
 * pode ser salva nem transmitida: a checagem acontece aqui, antes do claim.
 *
 * ── Modos ───────────────────────────────────────────────────────────────────
 *  - PADRAO        SEFAZ direto: env atual (idêntico). Focus: não envia nada (idêntico).
 *  - PROVEDOR      Focus: não envia nada, o Focus preenche. SEFAZ direto: proibido.
 *  - PERSONALIZADO dados da empresa. idCSRT + CSRT só no SEFAZ direto (no Focus o
 *                  hash depende do cNF que o próprio Focus gera).
 *  - NENHUM        SEFAZ direto: omite `<infRespTec>`. Focus: não oferecido.
 *
 * Mensagens em pt-BR com acento (UI). Onde a mensagem é LANÇADA na emissão, o
 * resolver passa por `paraMensagemSemAcento`, porque a rota `/issue` só mapeia
 * para 400 textos com "incompleto"/"invalid" sem acento.
 *
 * Módulo PURO e seguro no client: importa só `app/lib/masks` (sem imports) e tipos.
 */

import { isValidCnpj } from "../../lib/masks";
import type { AmbienteFiscal, ProvedorFiscal } from "../numeracao/tipos";

export type RespTecModo = "PADRAO" | "PROVEDOR" | "PERSONALIZADO" | "NENHUM";

export const RESP_TEC_MODOS: readonly RespTecModo[] = [
  "PADRAO",
  "PROVEDOR",
  "PERSONALIZADO",
  "NENHUM",
];

export function isRespTecModo(valor: unknown): valor is RespTecModo {
  return (
    typeof valor === "string" &&
    (RESP_TEC_MODOS as readonly string[]).includes(valor)
  );
}

/** Mesmo default de `provider-factory.ts`: tudo que não é SEFAZ_DIRECT é Focus. */
export function normalizarProvedorFiscal(
  providerName: string | null | undefined,
): ProvedorFiscal {
  return providerName === "SEFAZ_DIRECT" ? "SEFAZ_DIRECT" : "FOCUS_NFE";
}

export function modosPermitidos(providerName: string | null): RespTecModo[] {
  return normalizarProvedorFiscal(providerName) === "SEFAZ_DIRECT"
    ? ["PADRAO", "PERSONALIZADO", "NENHUM"]
    : ["PADRAO", "PROVEDOR", "PERSONALIZADO"];
}

/** Limites do leiaute (infRespTec: xContato/email TString 2–60/6–60, fone 6–14 dígitos). */
export const RESP_TEC_LIMITES = {
  xContatoMin: 2,
  xContatoMax: 60,
  emailMin: 6,
  emailMax: 60,
  foneMin: 6,
  foneMax: 14,
  csrtMax: 128,
} as const;

// ───────────────────────────── Exigências por UF ─────────────────────────────

export interface RequisitoRespTecUf {
  /** A SEFAZ da UF exige o grupo `infRespTec` (rejeição 972). */
  exigeRespTec: boolean;
  /** Em PRODUÇÃO a UF exige idCSRT + hashCSRT (rejeição 975). */
  exigeCsrtEmProducao: boolean;
  /** A UF confere o CNPJ do RT contra a autorização da empresa (rejeição 974). */
  validaFornecedorAutorizado: boolean;
  /** Base da regra (documentação; não é exibida). */
  fonte: string;
}

const SEM_EXIGENCIA: RequisitoRespTecUf = Object.freeze({
  exigeRespTec: false,
  exigeCsrtEmProducao: false,
  validaFornecedorAutorizado: false,
  fonte: "Sem exigencia conhecida de responsavel tecnico nesta UF",
});

/**
 * Tabela por UF. Só entra o que está documentado; o resto cai em SEM_EXIGENCIA.
 * CSRT desconhecido = false (a regra 975 não é presumida sem fonte).
 */
export const REQUISITOS_RT_POR_UF: Readonly<Record<string, RequisitoRespTecUf>> =
  Object.freeze({
    PR: Object.freeze({
      exigeRespTec: true,
      exigeCsrtEmProducao: true,
      validaFornecedorAutorizado: true,
      fonte:
        "NT 2018.005 (972/973); regra 7ZD02-10 (974) contra o UPD da Receita PR, em producao desde 05/05/2025; CSRT obrigatorio em producao desde 01/04/2026 (975)",
    }),
    AM: Object.freeze({
      exigeRespTec: true,
      exigeCsrtEmProducao: false,
      validaFornecedorAutorizado: false,
      fonte: "NT 2018.005 (972/973); exigencia de CSRT nao confirmada",
    }),
    MS: Object.freeze({
      exigeRespTec: true,
      exigeCsrtEmProducao: false,
      validaFornecedorAutorizado: false,
      fonte: "NT 2018.005 (972/973); exigencia de CSRT nao confirmada",
    }),
    PE: Object.freeze({
      exigeRespTec: true,
      exigeCsrtEmProducao: false,
      validaFornecedorAutorizado: false,
      fonte: "NT 2018.005 (972/973); exigencia de CSRT nao confirmada",
    }),
    SC: Object.freeze({
      exigeRespTec: true,
      exigeCsrtEmProducao: false,
      validaFornecedorAutorizado: false,
      fonte: "NT 2018.005 (972/973); exigencia de CSRT nao confirmada",
    }),
    TO: Object.freeze({
      exigeRespTec: true,
      exigeCsrtEmProducao: false,
      validaFornecedorAutorizado: false,
      fonte: "NT 2018.005 (972/973); exigencia de CSRT nao confirmada",
    }),
  });

export function normalizarUf(uf: string | null | undefined): string | null {
  const t = typeof uf === "string" ? uf.trim().toUpperCase() : "";
  return t ? t : null;
}

export function requisitosRespTecUf(
  uf: string | null | undefined,
): RequisitoRespTecUf {
  const u = normalizarUf(uf);
  if (!u) return SEM_EXIGENCIA;
  return Object.prototype.hasOwnProperty.call(REQUISITOS_RT_POR_UF, u)
    ? REQUISITOS_RT_POR_UF[u]
    : SEM_EXIGENCIA;
}

// ───────────────────────────── Validação ─────────────────────────────

export interface RespTecEntrada {
  /** Vem do corpo da requisição ou da linha do banco (TEXT): validado aqui. */
  modo: string | null | undefined;
  cnpj?: string | null;
  xContato?: string | null;
  email?: string | null;
  fone?: string | null;
  idCsrt?: string | null;
  /** CSRT digitado agora (texto puro). Vazio/ausente = manter o salvo. */
  csrtNovo?: string | null;
  /** Já existe CSRT cifrado salvo para a empresa. */
  csrtConfigurado: boolean;
  /** Pedido explícito para apagar idCSRT + CSRT salvos. */
  removerCsrt?: boolean;
}

export interface RespTecContexto {
  providerName: string | null;
  uf: string | null;
  ambiente: AmbienteFiscal;
}

export interface RespTecNormalizado {
  modo: RespTecModo;
  /** Só dígitos. */
  cnpj: string | null;
  xContato: string | null;
  email: string | null;
  /** Só dígitos. */
  fone: string | null;
  /**
   * null quando removido ou quando não se aplica (Focus Personalizado). Nos
   * modos sem dados segue o valor recebido, só aparado e sem validação.
   */
  idCsrt: string | null;
  /** CSRT novo a cifrar; null = manter o salvo (ou remover, ver `removerCsrt`). */
  csrtNovo: string | null;
  removerCsrt: boolean;
}

export type RespTecValidacao =
  | { ok: true; normalizado: RespTecNormalizado }
  | { ok: false; erros: Record<string, string> };

export const MSG_CSRT_NAO_ENVIADO_FOCUS =
  "O CSRT não é enviado via Focus: o hash depende do cNF gerado pelo Focus";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** TString do leiaute: caracteres de U+0020 a U+00FF. */
const TSTRING_RE = /^[\x20-\xFF]*$/;
const CNPJ_CARACTERES_RE = /^[\d.\-\/\s]+$/;
const FONE_CARACTERES_RE = /^[\d()\-+.\s]+$/;
const ID_CSRT_RE = /^\d{2}$/;

function texto(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function soDigitos(v: string): string {
  return v.replace(/\D/g, "");
}

function ouNull(v: string): string | null {
  return v ? v : null;
}

/** CSRT: 1–128 caracteres, sem espaço. */
export function csrtFormatoValido(csrt: string): boolean {
  return (
    csrt.length >= 1 &&
    csrt.length <= RESP_TEC_LIMITES.csrtMax &&
    !/\s/.test(csrt)
  );
}

function definir(erros: Record<string, string>, campo: string, msg: string) {
  if (!erros[campo]) erros[campo] = msg;
}

function textoUf(uf: string | null): string {
  return uf ?? "da empresa";
}

export function validarRespTec(
  i: RespTecEntrada,
  ctx: RespTecContexto,
): RespTecValidacao {
  const erros: Record<string, string> = {};
  const provedor = normalizarProvedorFiscal(ctx.providerName);
  const uf = normalizarUf(ctx.uf);
  const req = requisitosRespTecUf(uf);
  const producao = ctx.ambiente === "PRODUCAO";

  const modo = texto(i.modo);
  if (!isRespTecModo(modo)) {
    return {
      ok: false,
      erros: { modo: "Modo do responsável técnico inválido." },
    };
  }
  if (!modosPermitidos(provedor).includes(modo)) {
    return {
      ok: false,
      erros: {
        modo:
          provedor === "SEFAZ_DIRECT"
            ? "Modo do responsável técnico inválido: o modo Provedor não se aplica ao SEFAZ Direto, escolha Padrão, Personalizado ou Nenhum."
            : "Modo do responsável técnico inválido: o modo Nenhum não está disponível no Focus NFe, que sempre informa o responsável técnico.",
      },
    };
  }

  const cnpjTxt = texto(i.cnpj);
  const xContato = texto(i.xContato);
  const email = texto(i.email);
  const foneTxt = texto(i.fone);
  const idCsrt = texto(i.idCsrt);
  const csrtNovo = texto(i.csrtNovo);
  const removerCsrt = i.removerCsrt === true;

  // ── Modos sem dados: campos não são validados; valores seguem aparados para
  // o chamador poder preservá-los (o usuário pode voltar ao Personalizado). ──
  if (modo !== "PERSONALIZADO") {
    if (modo === "NENHUM" && req.exigeRespTec) {
      erros.modo = `A UF ${textoUf(uf)} exige o grupo do responsável técnico na nota (rejeição 972): o modo Nenhum não pode ser usado.`;
      return { ok: false, erros };
    }
    return {
      ok: true,
      normalizado: {
        modo,
        cnpj: ouNull(soDigitos(cnpjTxt)),
        xContato: ouNull(xContato),
        email: ouNull(email),
        fone: ouNull(soDigitos(foneTxt)),
        idCsrt: removerCsrt ? null : ouNull(idCsrt),
        csrtNovo: null,
        removerCsrt,
      },
    };
  }

  // ── PERSONALIZADO: dados completos ──
  const cnpj = soDigitos(cnpjTxt);
  if (!cnpjTxt) {
    erros.cnpj = "Informe o CNPJ do responsável técnico.";
  } else if (!CNPJ_CARACTERES_RE.test(cnpjTxt) || cnpj.length !== 14) {
    erros.cnpj = "CNPJ do responsável técnico inválido: informe os 14 dígitos.";
  } else if (!isValidCnpj(cnpj)) {
    erros.cnpj =
      "CNPJ do responsável técnico inválido: os dígitos verificadores não conferem.";
  }

  if (!xContato) {
    erros.xContato = "Informe o nome do contato do responsável técnico.";
  } else if (
    xContato.length < RESP_TEC_LIMITES.xContatoMin ||
    xContato.length > RESP_TEC_LIMITES.xContatoMax
  ) {
    erros.xContato = `Contato do responsável técnico inválido: use de ${RESP_TEC_LIMITES.xContatoMin} a ${RESP_TEC_LIMITES.xContatoMax} caracteres.`;
  } else if (!TSTRING_RE.test(xContato)) {
    erros.xContato =
      "Contato do responsável técnico inválido: há caracteres que a SEFAZ não aceita.";
  }

  if (!email) {
    erros.email = "Informe o e-mail do responsável técnico.";
  } else if (
    email.length < RESP_TEC_LIMITES.emailMin ||
    email.length > RESP_TEC_LIMITES.emailMax ||
    !EMAIL_RE.test(email) ||
    !TSTRING_RE.test(email)
  ) {
    erros.email = `E-mail do responsável técnico inválido: use um endereço válido de ${RESP_TEC_LIMITES.emailMin} a ${RESP_TEC_LIMITES.emailMax} caracteres.`;
  }

  const fone = soDigitos(foneTxt);
  if (!foneTxt) {
    erros.fone = "Informe o telefone do responsável técnico.";
  } else if (
    !FONE_CARACTERES_RE.test(foneTxt) ||
    fone.length < RESP_TEC_LIMITES.foneMin ||
    fone.length > RESP_TEC_LIMITES.foneMax
  ) {
    erros.fone = `Telefone do responsável técnico inválido: use de ${RESP_TEC_LIMITES.foneMin} a ${RESP_TEC_LIMITES.foneMax} dígitos, com DDD.`;
  }

  let idCsrtFinal: string | null = null;
  let csrtNovoFinal: string | null = null;

  if (provedor === "FOCUS_NFE") {
    // CSRT salvo de quando a empresa era SEFAZ direto fica inerte (nunca vai
    // ao Focus); só é erro TENTAR configurar CSRT agora.
    if (csrtNovo || idCsrt) {
      erros.csrt = `${MSG_CSRT_NAO_ENVIADO_FOCUS}.`;
    }
    if (req.exigeCsrtEmProducao && producao) {
      definir(
        erros,
        "modo",
        `Modo do responsável técnico inválido: na UF ${textoUf(uf)}, em produção, o CSRT é obrigatório (rejeição 975) e não é enviado via Focus. Mantenha o Focus NFe como responsável técnico (modo Padrão ou Provedor).`,
      );
    }
  } else {
    if (removerCsrt) {
      if (csrtNovo) {
        erros.csrt =
          "Informe um novo CSRT ou marque para remover o salvo, não os dois.";
      }
    } else {
      if (idCsrt && !ID_CSRT_RE.test(idCsrt)) {
        erros.idCsrt =
          "Identificador do CSRT (idCSRT) inválido: use 2 dígitos, por exemplo 01.";
      }
      if (csrtNovo) {
        if (csrtNovo.length > RESP_TEC_LIMITES.csrtMax) {
          erros.csrt = `CSRT inválido: use no máximo ${RESP_TEC_LIMITES.csrtMax} caracteres.`;
        } else if (!csrtFormatoValido(csrtNovo)) {
          erros.csrt = "CSRT inválido: não pode conter espaços.";
        }
      }
      const temCsrt = csrtNovo !== "" || i.csrtConfigurado === true;
      const temId = idCsrt !== "";
      if (temId && !temCsrt) {
        definir(
          erros,
          "csrt",
          "CSRT incompleto: informe o CSRT junto com o idCSRT.",
        );
      } else if (!temId && temCsrt) {
        definir(
          erros,
          "idCsrt",
          "CSRT incompleto: informe o idCSRT junto com o CSRT.",
        );
      }
      idCsrtFinal = ouNull(idCsrt);
      csrtNovoFinal = ouNull(csrtNovo);
    }

    const csrtCompleto =
      !removerCsrt &&
      idCsrt !== "" &&
      (csrtNovo !== "" || i.csrtConfigurado === true);
    if (req.exigeCsrtEmProducao && producao && !csrtCompleto) {
      definir(
        erros,
        "csrt",
        `CSRT incompleto: na UF ${textoUf(uf)}, em produção, o CSRT do responsável técnico é obrigatório (rejeição 975). Informe o idCSRT e o CSRT.`,
      );
    }
  }

  if (Object.keys(erros).length > 0) return { ok: false, erros };

  return {
    ok: true,
    normalizado: {
      modo,
      cnpj,
      xContato,
      email,
      fone,
      idCsrt: idCsrtFinal,
      csrtNovo: csrtNovoFinal,
      removerCsrt,
    },
  };
}

// ───────────────────────────── Avisos para a UI ─────────────────────────────

export type NivelAvisoRespTec = "info" | "alerta" | "bloqueio";

export interface AvisoRespTec {
  codigo: string;
  /** "bloqueio" = a emissão será recusada antes do envio com esta configuração. */
  nivel: NivelAvisoRespTec;
  mensagem: string;
}

export interface AvisosRespTecContexto extends RespTecContexto {
  /** Modo salvo; null/undefined = sem configuração (equivale a PADRAO). */
  modo?: string | null;
  idCsrt?: string | null;
  csrtConfigurado?: boolean;
  /**
   * SEFAZ direto + PADRAO: o que o padrão do sistema (env `NFE_RESP_TEC_*`)
   * resolve, calculado no servidor. null/undefined = não informado.
   */
  padraoSistema?: { configurado: boolean; temCsrt: boolean } | null;
}

/**
 * Avisos do card de responsável técnico. Os de nível "bloqueio" espelham
 * exatamente o que `resolveRespTec` recusa na emissão (com dados completos).
 */
export function avisosRespTec(ctx: AvisosRespTecContexto): AvisoRespTec[] {
  const avisos: AvisoRespTec[] = [];
  const provedor = normalizarProvedorFiscal(ctx.providerName);
  const uf = normalizarUf(ctx.uf);
  const ufTxt = textoUf(uf);
  const req = requisitosRespTecUf(uf);
  const producao = ctx.ambiente === "PRODUCAO";
  const modoTxt = texto(ctx.modo);
  const modo = modoTxt === "" ? "PADRAO" : modoTxt;

  if (!isRespTecModo(modo)) {
    avisos.push({
      codigo: "MODO_DESCONHECIDO",
      nivel: "bloqueio",
      mensagem:
        "O modo do responsável técnico salvo é desconhecido: salve a configuração novamente.",
    });
    return avisos;
  }

  if (provedor === "SEFAZ_DIRECT") {
    if (modo === "PROVEDOR") {
      avisos.push({
        codigo: "PROVEDOR_NO_SEFAZ",
        nivel: "bloqueio",
        mensagem:
          "O modo Provedor não se aplica ao SEFAZ Direto: escolha Padrão, Personalizado ou Nenhum.",
      });
      return avisos;
    }
    if (modo === "PADRAO") {
      const padrao = ctx.padraoSistema ?? null;
      if (req.exigeRespTec && padrao?.configurado === false) {
        avisos.push({
          codigo: "PADRAO_SEM_RESP_TEC",
          nivel: "alerta",
          mensagem: `A UF ${ufTxt} exige o responsável técnico (rejeição 972) e o padrão do sistema não informa nenhum: use o modo Personalizado.`,
        });
      } else if (req.exigeCsrtEmProducao && producao && padrao?.temCsrt !== true) {
        avisos.push({
          codigo: "PADRAO_SEM_CSRT_PRODUCAO",
          nivel: "alerta",
          mensagem: `Na UF ${ufTxt}, em produção, a SEFAZ exige o CSRT do responsável técnico (rejeição 975) e o padrão do sistema não tem CSRT: use o modo Personalizado com o CNPJ e o CSRT do fornecedor autorizado pela empresa.`,
        });
      }
    }
    if (modo === "NENHUM" && req.exigeRespTec) {
      avisos.push({
        codigo: "NENHUM_UF_EXIGE",
        nivel: "bloqueio",
        mensagem: `A UF ${ufTxt} exige o grupo do responsável técnico na nota (rejeição 972): o modo Nenhum será recusado na emissão.`,
      });
    }
    if (modo === "PERSONALIZADO" && req.exigeCsrtEmProducao) {
      const csrtCompleto =
        texto(ctx.idCsrt) !== "" && ctx.csrtConfigurado === true;
      if (!csrtCompleto) {
        avisos.push(
          producao
            ? {
                codigo: "PERSONALIZADO_SEM_CSRT_PRODUCAO",
                nivel: "bloqueio",
                mensagem: `Na UF ${ufTxt}, em produção, o CSRT do responsável técnico é obrigatório (rejeição 975): informe o idCSRT e o CSRT.`,
              }
            : {
                codigo: "PERSONALIZADO_SEM_CSRT_HOMOLOGACAO",
                nivel: "alerta",
                mensagem: `Ao passar para produção, a UF ${ufTxt} vai exigir o CSRT do responsável técnico (rejeição 975).`,
              },
        );
      }
    }
    if (req.validaFornecedorAutorizado && modo !== "NENHUM") {
      avisos.push({
        codigo: "FORNECEDOR_AUTORIZADO_UF",
        nivel: "info",
        mensagem: `Na UF ${ufTxt}, a SEFAZ confere se a empresa autorizou o CNPJ do responsável técnico no cadastro da Receita Estadual (rejeição 974).`,
      });
    }
    return avisos;
  }

  // ── Focus NFe ──
  if (modo === "NENHUM") {
    avisos.push({
      codigo: "NENHUM_NO_FOCUS",
      nivel: "info",
      mensagem:
        "No Focus NFe o modo Nenhum equivale a Provedor: o Focus informa o responsável técnico.",
    });
  }
  if (modo === "PERSONALIZADO") {
    if (req.exigeCsrtEmProducao) {
      avisos.push(
        producao
          ? {
              codigo: "FOCUS_PERSONALIZADO_UF_EXIGE_CSRT",
              nivel: "bloqueio",
              mensagem: `Na UF ${ufTxt}, em produção, o CSRT é obrigatório (rejeição 975) e não é enviado via Focus: mantenha o Focus NFe como responsável técnico (modo Padrão ou Provedor).`,
            }
          : {
              codigo: "FOCUS_PERSONALIZADO_UF_EXIGE_CSRT_HOMOLOGACAO",
              nivel: "alerta",
              mensagem: `Em produção, na UF ${ufTxt}, o modo Personalizado é recusado no Focus NFe, porque o CSRT é obrigatório e não é enviado via Focus.`,
            },
      );
    }
    if (ctx.csrtConfigurado === true) {
      avisos.push({
        codigo: "CSRT_IGNORADO_NO_FOCUS",
        nivel: "info",
        mensagem:
          "O CSRT salvo não é usado no Focus NFe: o hash depende do cNF gerado pelo Focus.",
      });
    }
  }
  if (req.validaFornecedorAutorizado) {
    avisos.push({
      codigo: "FORNECEDOR_AUTORIZADO_UF",
      nivel: "info",
      mensagem:
        modo === "PERSONALIZADO"
          ? `Na UF ${ufTxt}, a SEFAZ confere se a empresa autorizou o CNPJ do responsável técnico no cadastro da Receita Estadual (rejeição 974).`
          : `Na UF ${ufTxt}, a SEFAZ confere se a empresa autorizou no cadastro da Receita Estadual o CNPJ que o Focus NFe informa como responsável técnico (rejeição 974). Confirme esse CNPJ com o suporte do Focus.`,
    });
  }
  return avisos;
}

// ───────────────────────────── Mensagem da emissão ─────────────────────────────

/**
 * Converte a mensagem para ASCII imprimível sem acento. A rota `/issue` só
 * devolve 400 quando o texto contém "incompleto"/"invalid" SEM acento.
 */
export function paraMensagemSemAcento(mensagem: string): string {
  return mensagem
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}
