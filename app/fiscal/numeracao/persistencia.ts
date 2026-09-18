import type { ChaveFiscal, EventoTrilha } from "./decisao";
import type { EstadoReserva, FaseTentativa, ProvedorFiscal } from "./tipos";

export interface Reserva {
  id: string;
  userId: string;
  companyFiscalConfigId: string;
  ambiente: string;
  modelo: string;
  serie: number;
  numero: number;
  nfeId: string | null;
  estado: EstadoReserva;
  origem: "CONTADOR" | "LEGADO_V1" | "READBACK_FOCUS";
  cNF: string | null;
  provedorUltimo: string | null;
  ultimaClasse: string | null;
  ultimoCStat: number | null;
  ultimoCodigoProvedor: string | null;
  motivo: string | null;
  requerInutilizacao: boolean;
  bloqueadoAte: Date | null;
  leaseAte: Date | null;
  consumidoEm: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Tentativa {
  id: string;
  reservaId: string;
  nfeId: string;
  userId: string;
  seq: number;
  provedor: ProvedorFiscal;
  ambiente: string;
  tpEmis: number;
  chaveAcesso: string | null;
  cNF: string | null;
  dhEmi: Date | null;
  digestValue: string | null;
  xmlAssinadoPath: string | null;
  conteudoSha256: string;
  focusRef: string | null;
  nRec: string | null;
  fase: FaseTentativa;
  httpStatus: number | null;
  transporte: string | null;
  cStat: number | null;
  codigoProvedor: string | null;
  classe: string | null;
  prova: string | null;
  mensagem: string | null;
  protocolo: string | null;
  numeroLido: number | null;
  serieLida: number | null;
  transmitidaEm: Date;
  respondidaEm: Date | null;
  consultadaEm: Date | null;
  createdAt: Date;
}

export interface ContextoReserva {
  claimEm?:Date;
  calculo?:Pick<import("../../interfaces/nfe.interface").NfeDraftResponse,"totaisJson"|"itens">;
  userId: string;
  nfeId: string;
  key: ChaveFiscal;
  isDefault: boolean;
  row: { numero: number; serie: number; ambiente: string; modelo?: string; companyFiscalConfigId: string | null; status: string; cStatRejeicao?: number | null };
  providerName: ProvedorFiscal;
  confirmarDescarte?: boolean;
  actorUserId?:string;
  emitenteSnapshot: unknown;
}

export type NovaReserva = Pick<Reserva, "userId" | "companyFiscalConfigId" | "ambiente" | "modelo" | "serie" | "numero" | "nfeId" | "estado" | "origem" | "cNF"> & Partial<Pick<Reserva, "ultimoCStat">>;
export type ReservaPatch = Partial<Pick<Reserva, "motivo" | "requerInutilizacao" | "bloqueadoAte" | "leaseAte" | "consumidoEm" | "provedorUltimo" | "ultimaClasse" | "ultimoCStat" | "ultimoCodigoProvedor">>;
export type TentativaPatch = Partial<Pick<Tentativa, "fase" | "httpStatus" | "transporte" | "cStat" | "codigoProvedor" | "classe" | "prova" | "mensagem" | "protocolo" | "numeroLido" | "serieLida" | "nRec" | "respondidaEm" | "consultadaEm">>;
export type NovaTentativa = Pick<Tentativa, "reservaId" | "nfeId" | "userId" | "seq" | "provedor" | "ambiente" | "chaveAcesso" | "cNF" | "dhEmi" | "digestValue" | "xmlAssinadoPath" | "conteudoSha256" | "focusRef" | "transmitidaEm">;
export type NotaPatch = { status: string; motivoRejeicao?: string | null; cStatRejeicao?: number | null; chaveAcesso?: string | null; protocoloAutorizacao?: string | null; dataAutorizacao?: Date; xmlAssinadoPath?: string | null; numero?: number; serie?: number };
export interface Sequencia { id: string; proximoNumero: number }
export interface Ocupacao { emNota: boolean; inutilizado: boolean; reservado: boolean }

/** Uma instância transacional não pode ser guardada nem usada após o callback. */
export interface NumeracaoTx {
  /** Present only in SQL transactions, for atomic fiscal extensions. */
  readonly sql?: Pick<import("@prisma/client").Prisma.TransactionClient,"$queryRawUnsafe"|"$executeRawUnsafe">;
  lockSequencia(userId: string, key: ChaveFiscal, isDefault: boolean): Promise<Sequencia>;
  avancarContador(id: string, cfc: string, proximo: number): Promise<number>;
  reservas(userId: string, nfeId: string, lock?: boolean): Promise<Reserva[]>;
  reserva(userId: string, id: string, lock?: boolean): Promise<Reserva | null>;
  reservasNaChave(userId: string, key: ChaveFiscal, lock?: boolean): Promise<Reserva[]>;
  inserirReserva(row: NovaReserva): Promise<Reserva>;
  transicionar(row: Reserva, estado: EstadoReserva, patch?: ReservaPatch): Promise<Reserva>;
  atualizarReserva(row: Reserva, patch: ReservaPatch): Promise<Reserva>;
  ocupacao(c: ContextoReserva, numero: number): Promise<Ocupacao>;
  pisoPorEvidencia(c: ContextoReserva): Promise<number>;
  trilha(userId: string, nfeId: string): Promise<EventoTrilha[]>;
  gravarNumero(c: ContextoReserva, numero: number): Promise<void>;
  tentativas(userId: string, reservaId: string, lock?: boolean): Promise<Tentativa[]>;
  inserirTentativa(row: NovaTentativa): Promise<Tentativa>;
  atualizarTentativa(row: Tentativa, patch: TentativaPatch): Promise<Tentativa>;
  atualizarNota(userId: string, nfeId: string, estados: string[], patch: NotaPatch): Promise<void>;
  excluirRascunho(userId: string, nfeId: string): Promise<void>;
  linhasNaFaixa(userId: string, key: ChaveFiscal, isDefault: boolean, ini: number, fim: number): Promise<Array<{id: string; numero: number; status: string}>>;
}
export interface INfeNumeracaoRepository extends NumeracaoTx {
  transaction<T>(fn: (tx: NumeracaoTx) => Promise<T>): Promise<T>;
}

export function chaveDaReserva(r: Reserva): ChaveFiscal {
  return { cfc: r.companyFiscalConfigId, ambiente: r.ambiente, modelo: r.modelo, serie: r.serie };
}
export function chaveOrdenavel(k: ChaveFiscal): string {
  return JSON.stringify([k.cfc, k.ambiente, k.modelo, k.serie]);
}
