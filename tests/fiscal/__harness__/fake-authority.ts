/**
 * "Verdade da SEFAZ" em memória para o harness de emissão.
 *
 * Guarda, por (cnpj, ambiente, modelo, série, número), o que a autoridade fiscal
 * considera consumido: autorizada | cancelada | inutilizada | denegada — com a
 * chave, o digest e o protocolo. Rejeições NUNCA são guardadas (a SEFAZ não
 * consome número em rejeição), que é exatamente a regra que a numeração tem de
 * respeitar.
 *
 * Regras espelhadas da SEFAZ (MOC 7.0):
 *  - autorizar número já autorizado com a MESMA chave → 204; com outra → 539;
 *  - autorizar número inutilizado → 206; denegado → 205; cancelado → 218;
 *  - consultar chave desconhecida → 217; cancelada → 101; denegada → 110.
 *
 * Arquivo de TESTE, sem `vi.mock`. Importa só módulos puros não mockados.
 */

import { montarChave, chaveToString } from "../../../app/fiscal/sefaz/chave-acesso";
import type { UF } from "../../../app/fiscal/sefaz/endpoints";
import type {
  AmbienteFiscal,
  ModeloFiscal,
} from "../../../app/fiscal/numeracao/tipos";

export type EstadoAutoridade = "autorizada" | "cancelada" | "inutilizada" | "denegada";

export interface IdentidadeFiscal {
  cnpj: string;
  ambiente: AmbienteFiscal;
  modelo: ModeloFiscal;
  serie: number;
  numero: number;
  /** UF do emitente — só para montar a chave (default da autoridade). */
  uf?: string;
}

export interface RegistroAutoridade {
  identidade: IdentidadeFiscal;
  estado: EstadoAutoridade;
  chave: string | null;
  digest: string | null;
  protocolo: string | null;
  /** nfeId (ref) que obteve a autorização — alimenta a invariante I2. */
  nfeId: string | null;
  ordem: number;
}

export interface RespostaAutoridade {
  cStat: number;
  xMotivo: string;
  protocolo: string | null;
  chave: string | null;
  registro: RegistroAutoridade | null;
}

export interface OpcoesChave {
  cNF?: string;
  ano?: number;
  mes?: number;
  tpEmis?: 1 | 6 | 7;
}

const CNF_PADRAO = "87654321";

function soDigitos(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

export function chaveIdentidade(id: IdentidadeFiscal): string {
  return [soDigitos(id.cnpj), id.ambiente, id.modelo, id.serie, id.numero].join("|");
}

/**
 * Extrai a identidade fiscal do `nfeData` que o use case entrega ao provider:
 *  - SEFAZ direto: `{ draft, config, numero }` (SefazEmitPayload);
 *  - Focus V1: JSON com `cnpj_emitente`, `serie`, `numero_nota` (ou `numero`).
 * O JSON Focus não carrega ambiente/modelo: vêm de `fallback`.
 */
export function identidadeDoPayload(
  nfeData: Record<string, any>,
  fallback: { ambiente?: AmbienteFiscal; modelo?: ModeloFiscal } = {},
): IdentidadeFiscal {
  if (nfeData?.draft && nfeData?.config) {
    const draft = nfeData.draft;
    const config = nfeData.config;
    return {
      cnpj: soDigitos(config.cnpj),
      ambiente: (draft.ambiente ?? config.ambiente ?? fallback.ambiente ?? "HOMOLOGACAO") as AmbienteFiscal,
      modelo: draft.modelo === "65" ? "65" : "55",
      serie: Number(draft.serie),
      numero: Number(nfeData.numero),
      uf: config.uf ?? undefined,
    };
  }
  return {
    cnpj: soDigitos(nfeData?.cnpj_emitente),
    ambiente: fallback.ambiente ?? "HOMOLOGACAO",
    modelo: fallback.modelo ?? "55",
    serie: Number(nfeData?.serie),
    numero: Number(nfeData?.numero ?? nfeData?.numero_nota),
    uf: nfeData?.uf_emitente ?? undefined,
  };
}

export class FakeAuthority {
  private registrosPorChave = new Map<string, RegistroAutoridade>();
  private ordem = 0;
  /** Defaults para montar chaves (AAMM fixo = determinístico). */
  padrao: { uf: string; ano: number; mes: number; cNF: string } = {
    uf: "SP",
    ano: 2026,
    mes: 9,
    cNF: CNF_PADRAO,
  };

  reset(): void {
    this.registrosPorChave.clear();
    this.ordem = 0;
    this.padrao = { uf: "SP", ano: 2026, mes: 9, cNF: CNF_PADRAO };
  }

  /** Chave de 44 dígitos válida (DV real) para a identidade. */
  montarChave(id: IdentidadeFiscal, opts: OpcoesChave = {}): string {
    const cNFBase = opts.cNF ?? this.padrao.cNF;
    // Rejeição 778: cNF não pode ser igual ao nNF.
    const cNF = Number(cNFBase) === id.numero ? "87654329" : cNFBase;
    return chaveToString(
      montarChave({
        uf: (id.uf ?? this.padrao.uf) as UF,
        ano: opts.ano ?? this.padrao.ano,
        mes: opts.mes ?? this.padrao.mes,
        cnpj: soDigitos(id.cnpj),
        modelo: id.modelo,
        serie: id.serie,
        numero: id.numero,
        tpEmis: opts.tpEmis ?? 1,
        cNF,
      }),
    );
  }

  private protocolo(): string {
    return String(135260000000000 + this.ordem);
  }

  private registrar(
    id: IdentidadeFiscal,
    estado: EstadoAutoridade,
    dados: { chave: string | null; digest?: string | null; nfeId?: string | null },
  ): RegistroAutoridade {
    this.ordem += 1;
    const reg: RegistroAutoridade = {
      identidade: { ...id, cnpj: soDigitos(id.cnpj) },
      estado,
      chave: dados.chave,
      digest: dados.digest ?? null,
      protocolo: estado === "inutilizada" ? null : this.protocolo(),
      nfeId: dados.nfeId ?? null,
      ordem: this.ordem,
    };
    this.registrosPorChave.set(chaveIdentidade(id), reg);
    return reg;
  }

  private conflito(id: IdentidadeFiscal, chave: string): RespostaAutoridade | null {
    const atual = this.registrosPorChave.get(chaveIdentidade(id));
    if (!atual) return null;
    const base = { protocolo: atual.protocolo, chave: atual.chave, registro: { ...atual } };
    switch (atual.estado) {
      case "inutilizada":
        return { ...base, cStat: 206, xMotivo: "Rejeicao: NF-e ja esta inutilizada na Base de dados da SEFAZ" };
      case "denegada":
        return { ...base, cStat: 205, xMotivo: "Rejeicao: NF-e esta denegada na base de dados da SEFAZ" };
      case "cancelada":
        return { ...base, cStat: 218, xMotivo: "Rejeicao: NF-e ja esta cancelada na base de dados da SEFAZ" };
      case "autorizada":
        return atual.chave === chave
          ? { ...base, cStat: 204, xMotivo: "Rejeicao: Duplicidade de NF-e" }
          : {
              ...base,
              cStat: 539,
              xMotivo: `Rejeicao: Duplicidade de NF-e, com diferenca na Chave de Acesso [chNFe: ${atual.chave}]`,
            };
    }
  }

  /** Tenta autorizar. 100 grava; qualquer outro cStat não altera nada. */
  autorizar(
    id: IdentidadeFiscal,
    dados: { chave?: string; digest?: string | null; nfeId?: string | null } = {},
  ): RespostaAutoridade {
    const chave = dados.chave ?? this.montarChave(id);
    const c = this.conflito(id, chave);
    if (c) return c;
    const reg = this.registrar(id, "autorizada", { chave, digest: dados.digest, nfeId: dados.nfeId });
    return { cStat: 100, xMotivo: "Autorizado o uso da NF-e", protocolo: reg.protocolo, chave, registro: { ...reg } };
  }

  /** Denegação (110): o número fica consumido. */
  denegar(
    id: IdentidadeFiscal,
    dados: { chave?: string; nfeId?: string | null } = {},
  ): RespostaAutoridade {
    const chave = dados.chave ?? this.montarChave(id);
    const c = this.conflito(id, chave);
    if (c) return c;
    const reg = this.registrar(id, "denegada", { chave, nfeId: dados.nfeId });
    return { cStat: 110, xMotivo: "Uso Denegado", protocolo: reg.protocolo, chave, registro: { ...reg } };
  }

  /** Inutiliza [numeroInicial, numeroFinal] da identidade (ignora `numero`). */
  inutilizar(
    id: Omit<IdentidadeFiscal, "numero">,
    numeroInicial: number,
    numeroFinal: number,
  ): RespostaAutoridade {
    for (let n = numeroInicial; n <= numeroFinal; n++) {
      const atual = this.registrosPorChave.get(chaveIdentidade({ ...id, numero: n }));
      if (atual && atual.estado !== "inutilizada") {
        return {
          cStat: 241,
          xMotivo: `Rejeicao: Um numero da faixa ja foi utilizado (${n})`,
          protocolo: null,
          chave: atual.chave,
          registro: { ...atual },
        };
      }
    }
    for (let n = numeroInicial; n <= numeroFinal; n++) {
      this.registrar({ ...id, numero: n }, "inutilizada", { chave: null });
    }
    return { cStat: 102, xMotivo: "Inutilizacao de numero homologado", protocolo: this.protocolo(), chave: null, registro: null };
  }

  cancelar(chave: string): RespostaAutoridade {
    const reg = this.porChave(chave);
    if (!reg) return { cStat: 217, xMotivo: "Rejeicao: NF-e nao consta na base de dados da SEFAZ", protocolo: null, chave, registro: null };
    if (reg.estado === "cancelada") {
      return { cStat: 218, xMotivo: "Rejeicao: NF-e ja esta cancelada na base de dados da SEFAZ", protocolo: reg.protocolo, chave, registro: { ...reg } };
    }
    if (reg.estado !== "autorizada") {
      return { cStat: 205, xMotivo: "Rejeicao: NF-e esta denegada na base de dados da SEFAZ", protocolo: reg.protocolo, chave, registro: { ...reg } };
    }
    reg.estado = "cancelada";
    return { cStat: 135, xMotivo: "Evento registrado e vinculado a NF-e", protocolo: this.protocolo(), chave, registro: { ...reg } };
  }

  consultarPorChave(chave: string): RespostaAutoridade {
    const reg = this.porChave(chave);
    if (!reg) return { cStat: 217, xMotivo: "Rejeicao: NF-e nao consta na base de dados da SEFAZ", protocolo: null, chave, registro: null };
    const mapa: Record<EstadoAutoridade, [number, string]> = {
      autorizada: [100, "Autorizado o uso da NF-e"],
      cancelada: [101, "Cancelamento de NF-e homologado"],
      denegada: [110, "Uso Denegado"],
      inutilizada: [102, "Inutilizacao de numero homologado"],
    };
    const [cStat, xMotivo] = mapa[reg.estado];
    return { cStat, xMotivo, protocolo: reg.protocolo, chave, registro: { ...reg } };
  }

  consultar(id: IdentidadeFiscal): RegistroAutoridade | null {
    const r = this.registrosPorChave.get(chaveIdentidade(id));
    return r ? { ...r } : null;
  }

  registros(filtro: Partial<Omit<IdentidadeFiscal, "numero" | "uf">> = {}): RegistroAutoridade[] {
    return [...this.registrosPorChave.values()]
      .filter(
        (r) =>
          (filtro.cnpj === undefined || r.identidade.cnpj === soDigitos(filtro.cnpj)) &&
          (filtro.ambiente === undefined || r.identidade.ambiente === filtro.ambiente) &&
          (filtro.modelo === undefined || r.identidade.modelo === filtro.modelo) &&
          (filtro.serie === undefined || r.identidade.serie === filtro.serie),
      )
      .sort((a, b) => a.ordem - b.ordem)
      .map((r) => ({ ...r }));
  }

  /** Números fiscalmente consumidos por autorização (autorizada ou cancelada), em ordem crescente. */
  numerosAutorizados(filtro: Partial<Omit<IdentidadeFiscal, "numero" | "uf">> = {}): number[] {
    return this.registros(filtro)
      .filter((r) => r.estado === "autorizada" || r.estado === "cancelada")
      .map((r) => r.identidade.numero)
      .sort((a, b) => a - b);
  }

  /** Quantas autorizações (inclusive canceladas depois) um nfeId obteve. */
  autorizacoesPorNfe(nfeId: string): number {
    return [...this.registrosPorChave.values()].filter(
      (r) => r.nfeId === nfeId && (r.estado === "autorizada" || r.estado === "cancelada"),
    ).length;
  }

  private porChave(chave: string): RegistroAutoridade | undefined {
    const alvo = soDigitos(chave);
    return [...this.registrosPorChave.values()].find((r) => r.chave === alvo);
  }
}
