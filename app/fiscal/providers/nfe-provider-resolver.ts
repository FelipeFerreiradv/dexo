/**
 * Resolver central do provedor fiscal de uma emissão: provedor, ambiente,
 * endereço/credencial do Focus, UF do SEFAZ direto, quem numera e a política
 * de responsável técnico (RT).
 *
 * PURO: sem I/O, sem `process.env`, sem crypto. O chamador decide as flags
 * (allowlist por companyFiscalConfigId em `app/fiscal/flags.ts`) e injeta o
 * `decryptSecret` (`app/fiscal/certificate/fiscal-secret.ts`).
 *
 * ── Tabela de RT (plano §F6) ────────────────────────────────────────────────
 * | Modo                          | SEFAZ direto          | Focus                    |
 * |-------------------------------|-----------------------|--------------------------|
 * | PADRAO / sem linha / flag off | ENV_LEGADO (idêntico) | PROVEDOR (idêntico)      |
 * | PROVEDOR                      | erro                  | PROVEDOR                 |
 * | PERSONALIZADO                 | EMPRESA + idCSRT/CSRT | EMPRESA, nunca com CSRT  |
 * | NENHUM                        | OMITIR                | PROVEDOR                 |
 * Exigências por UF (972/975) vêm de `app/fiscal/domain/resp-tec.ts`.
 *
 * ── Segredos ────────────────────────────────────────────────────────────────
 * `focus.token` e `respTec.dados.csrt` NUNCA vão para log, auditoria ou
 * mensagem de erro. Para logar, use `resolvedParaLog`.
 */

import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import type { NfeRespTec } from "../sefaz/nfe-xml-builder-sefaz.service";
import type {
  AmbienteFiscal,
  ModeloFiscal,
  ProvedorFiscal,
} from "../numeracao/tipos";
import {
  csrtFormatoValido,
  isRespTecModo,
  normalizarProvedorFiscal,
  normalizarUf,
  paraMensagemSemAcento,
  validarRespTec,
} from "../domain/resp-tec";

/** Linha de `CompanyFiscalRespTec` (modo é TEXT no banco: validado aqui). */
export interface RespTecRow {
  modo: string;
  cnpj: string | null;
  xContato: string | null;
  email: string | null;
  fone: string | null;
  idCsrt: string | null;
  /** CSRT cifrado (AES-256-GCM, FISCAL_CERT_ENC_KEY). */
  csrtEnc: string | null;
}

export type RespTecPolicy =
  /** SEFAZ direto: o provider resolve pela env `NFE_RESP_TEC_*` (comportamento atual). */
  | { origem: "ENV_LEGADO" }
  /** Focus: não envia RT, o Focus preenche o dele (comportamento atual). */
  | { origem: "PROVEDOR" }
  /** SEFAZ direto: `payload.respTec = null` ⇒ sem `<infRespTec>`. */
  | { origem: "OMITIR" }
  /** Dados da empresa. No Focus, nunca carrega idCSRT/csrt. */
  | { origem: "EMPRESA"; dados: NfeRespTec };

export interface NfeProviderFocus {
  baseUrl: string;
  path: "nfe" | "nfce";
  /** Segredo: nunca logar este objeto (ver `resolvedParaLog`). */
  token: string;
}

export interface NfeProviderResolved {
  providerName: ProvedorFiscal;
  ambiente: AmbienteFiscal;
  modelo: ModeloFiscal;
  focus: NfeProviderFocus | null;
  sefaz: { uf: string } | null;
  numeracao: "DEXO" | "PROVEDOR";
  respTec: RespTecPolicy;
}

/** Subconjunto de `CompanyFiscalConfig` que o resolver lê (a config inteira serve). */
export type ConfigParaResolverNfe = Pick<
  CompanyFiscalConfig,
  "providerName" | "providerToken" | "ambiente" | "uf"
>;

export interface ResolveNfeProviderOpcoes {
  modelo: ModeloFiscal;
  respTecRow: RespTecRow | null;
  /** Flag `NFE_RESP_TEC_EMPRESA_*` já decidida para esta config. */
  respTecAtivo: boolean;
  /** Sub-flag de numeração Dexo no Focus já decidida para esta config. */
  numeracaoDexoFocus: boolean;
  decryptSecret: (enc: string) => string;
}

export interface ResolveRespTecContexto {
  uf: string | null;
  ambiente: AmbienteFiscal;
}

export const FOCUS_BASE_URL: Readonly<Record<AmbienteFiscal, string>> =
  Object.freeze({
    HOMOLOGACAO: "https://homologacao.focusnfe.com.br",
    PRODUCAO: "https://api.focusnfe.com.br",
  });

export function focusBaseUrl(ambiente: AmbienteFiscal): string {
  return ambiente === "PRODUCAO"
    ? FOCUS_BASE_URL.PRODUCAO
    : FOCUS_BASE_URL.HOMOLOGACAO;
}

export function resolveNfeProviderConfig(
  config: ConfigParaResolverNfe,
  o: ResolveNfeProviderOpcoes,
): NfeProviderResolved {
  const providerName = normalizarProvedorFiscal(config.providerName);
  const ambiente: AmbienteFiscal =
    config.ambiente === "PRODUCAO" ? "PRODUCAO" : "HOMOLOGACAO";
  const modelo: ModeloFiscal = o.modelo === "65" ? "65" : "55";
  const uf = normalizarUf(config.uf);

  let focus: NfeProviderFocus | null = null;
  if (providerName === "FOCUS_NFE") {
    const token =
      typeof config.providerToken === "string"
        ? config.providerToken.trim()
        : "";
    if (!token) {
      throw new Error(
        `Token do provedor Focus NFe nao configurado para o ambiente ${ambiente}`,
      );
    }
    focus = {
      baseUrl: focusBaseUrl(ambiente),
      path: modelo === "65" ? "nfce" : "nfe",
      token,
    };
  }

  return {
    providerName,
    ambiente,
    modelo,
    focus,
    sefaz: providerName === "SEFAZ_DIRECT" ? { uf: uf ?? "" } : null,
    numeracao:
      providerName === "SEFAZ_DIRECT" || o.numeracaoDexoFocus
        ? "DEXO"
        : "PROVEDOR",
    respTec: resolveRespTec(
      providerName,
      o.respTecRow,
      o.respTecAtivo,
      o.decryptSecret,
      { uf, ambiente },
    ),
  };
}

function erroRespTec(erros: Record<string, string>): Error {
  return new Error(
    paraMensagemSemAcento(
      `Responsavel tecnico incompleto ou invalido: ${Object.values(erros).join(" ")}`,
    ),
  );
}

/**
 * Política de RT de uma emissão. Lança (mensagem sem acento, com
 * "invalido"/"incompleto") quando a configuração seria rejeitada pela SEFAZ,
 * para falhar ANTES do claim e da reserva de número.
 */
export function resolveRespTec(
  providerName: string | null,
  row: RespTecRow | null,
  respTecAtivo: boolean,
  decryptSecret: (enc: string) => string,
  ctx: ResolveRespTecContexto,
): RespTecPolicy {
  const provedor = normalizarProvedorFiscal(providerName);
  const linha = respTecAtivo ? row : null;

  if (!linha) {
    return provedor === "SEFAZ_DIRECT"
      ? { origem: "ENV_LEGADO" }
      : { origem: "PROVEDOR" };
  }

  const modo = typeof linha.modo === "string" ? linha.modo.trim() : "";
  if (!isRespTecModo(modo)) {
    throw new Error(
      "Responsavel tecnico invalido: modo desconhecido no cadastro da empresa, salve a configuracao novamente",
    );
  }

  const ctxValidacao = {
    providerName: provedor,
    uf: ctx.uf,
    ambiente: ctx.ambiente,
  };

  if (provedor === "FOCUS_NFE") {
    if (modo !== "PERSONALIZADO") return { origem: "PROVEDOR" };
    // CSRT salvo (de quando a empresa era SEFAZ direto) é inerte no Focus:
    // não entra na validação nem no resultado.
    const v = validarRespTec(
      {
        modo,
        cnpj: linha.cnpj,
        xContato: linha.xContato,
        email: linha.email,
        fone: linha.fone,
        idCsrt: null,
        csrtNovo: null,
        csrtConfigurado: false,
      },
      ctxValidacao,
    );
    if (!v.ok) throw erroRespTec(v.erros);
    return {
      origem: "EMPRESA",
      dados: {
        cnpj: v.normalizado.cnpj ?? "",
        xContato: v.normalizado.xContato ?? "",
        email: v.normalizado.email ?? "",
        fone: v.normalizado.fone ?? "",
      },
    };
  }

  // ── SEFAZ direto ──
  if (modo === "PADRAO") return { origem: "ENV_LEGADO" };
  if (modo === "PROVEDOR") {
    throw new Error(
      "Responsavel tecnico invalido: o modo Provedor nao se aplica ao SEFAZ Direto",
    );
  }

  const csrtEnc = typeof linha.csrtEnc === "string" ? linha.csrtEnc.trim() : "";
  const v = validarRespTec(
    {
      modo,
      cnpj: linha.cnpj,
      xContato: linha.xContato,
      email: linha.email,
      fone: linha.fone,
      idCsrt: linha.idCsrt,
      csrtNovo: null,
      csrtConfigurado: csrtEnc !== "",
    },
    ctxValidacao,
  );
  if (!v.ok) throw erroRespTec(v.erros);
  if (modo === "NENHUM") return { origem: "OMITIR" };

  const n = v.normalizado;
  const dados: NfeRespTec = {
    cnpj: n.cnpj ?? "",
    xContato: n.xContato ?? "",
    email: n.email ?? "",
    fone: n.fone ?? "",
  };

  // A validação garante o par: idCsrt presente ⇔ CSRT salvo.
  if (n.idCsrt && csrtEnc) {
    let csrt: string;
    try {
      const claro = decryptSecret(csrtEnc);
      csrt = typeof claro === "string" ? claro.trim() : "";
    } catch {
      // Sem `cause`: a mensagem da falha não deve carregar nada do segredo.
      throw new Error(
        "Responsavel tecnico invalido: CSRT ilegivel no cadastro da empresa, cadastre o CSRT novamente",
      );
    }
    if (!csrtFormatoValido(csrt)) {
      throw new Error(
        "Responsavel tecnico invalido: CSRT salvo em formato invalido, cadastre o CSRT novamente",
      );
    }
    dados.idCSRT = n.idCsrt;
    dados.csrt = csrt;
  }

  return { origem: "EMPRESA", dados };
}

/**
 * Política → `respTec` do payload do SEFAZ direto (`SefazEmitPayload.respTec` /
 * `prepararEmissao`): `undefined` = env atual, `null` = omitir o grupo,
 * objeto = dados da empresa. PROVEDOR não ocorre no SEFAZ direto; se chegar,
 * cai no comportamento atual (env).
 */
export function respTecParaPayloadSefaz(
  p: RespTecPolicy,
): NfeRespTec | null | undefined {
  switch (p.origem) {
    case "OMITIR":
      return null;
    case "EMPRESA":
      return { ...p.dados };
    default:
      return undefined;
  }
}

// ───────────────────────────── Log ─────────────────────────────

export type RespTecPolicyLog =
  | { origem: "ENV_LEGADO" }
  | { origem: "PROVEDOR" }
  | { origem: "OMITIR" }
  | {
      origem: "EMPRESA";
      dados: {
        cnpj: string;
        xContato: string;
        email: string;
        fone: string;
        idCSRT?: string;
        csrtConfigurado: boolean;
      };
    };

export interface NfeProviderResolvedLog {
  providerName: ProvedorFiscal;
  ambiente: AmbienteFiscal;
  modelo: ModeloFiscal;
  focus: { baseUrl: string; path: "nfe" | "nfce"; tokenConfigurado: boolean } | null;
  sefaz: { uf: string } | null;
  numeracao: "DEXO" | "PROVEDOR";
  respTec: RespTecPolicyLog;
}

/** Cópia segura para log: sem `focus.token` e sem `respTec.dados.csrt`. Não altera `r`. */
export function resolvedParaLog(r: NfeProviderResolved): NfeProviderResolvedLog {
  let respTec: RespTecPolicyLog;
  if (r.respTec.origem === "EMPRESA") {
    const d = r.respTec.dados;
    respTec = {
      origem: "EMPRESA",
      dados: {
        cnpj: d.cnpj,
        xContato: d.xContato,
        email: d.email,
        fone: d.fone,
        ...(d.idCSRT ? { idCSRT: d.idCSRT } : {}),
        csrtConfigurado: typeof d.csrt === "string" && d.csrt !== "",
      },
    };
  } else {
    respTec = { origem: r.respTec.origem };
  }

  return {
    providerName: r.providerName,
    ambiente: r.ambiente,
    modelo: r.modelo,
    focus: r.focus
      ? {
          baseUrl: r.focus.baseUrl,
          path: r.focus.path,
          tokenConfigurado: r.focus.token !== "",
        }
      : null,
    sefaz: r.sefaz ? { uf: r.sefaz.uf } : null,
    numeracao: r.numeracao,
    respTec,
  };
}
