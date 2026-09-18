import { randomUUID } from "node:crypto";
import type { ChaveFiscal, EventoTrilha } from "../../../app/fiscal/numeracao/decisao";
import { assertTransicao } from "../../../app/fiscal/numeracao/estados";
import { concorrencia } from "../../../app/fiscal/numeracao/numeracao.errors";
import { chaveOrdenavel } from "../../../app/fiscal/numeracao/persistencia";
import type { ContextoReserva, INfeNumeracaoRepository, NotaPatch, NovaReserva, NovaTentativa, NumeracaoTx, Reserva, ReservaPatch, Sequencia, Tentativa, TentativaPatch } from "../../../app/fiscal/numeracao/persistencia";
import { ESTADOS_VIVOS } from "../../../app/fiscal/numeracao/tipos";
import type { EstadoReserva } from "../../../app/fiscal/numeracao/tipos";

export interface NotaMemory { id: string; userId: string; status: string; numero: number; key: ChaveFiscal; [key: string]: unknown }
type Memory = {
  sequences: Map<string, Sequencia>;
  reservas: Map<string, Reserva>;
  tentativas: Map<string, Tentativa>;
  notas: Map<string, NotaMemory>;
  trilhas: Map<string, EventoTrilha[]>;
  pisos: Map<string, number>;
  inutilizadas: Array<{ key: ChaveFiscal; ini: number; fim: number }>;
  locks: Map<string, Promise<void>>;
  falharGravacao: boolean;
};
const copy = <T>(x: T): T => structuredClone(x);
const key = (userId: string, k: ChaveFiscal) => `${userId}:${chaveOrdenavel(k)}`;
const mesma = (r: Reserva, k: ChaveFiscal) => r.companyFiscalConfigId === k.cfc && r.ambiente === k.ambiente && r.modelo === k.modelo && r.serie === k.serie;

export class FakeNumeracaoRepository implements INfeNumeracaoRepository {
  readonly state: Memory;
  private releases: Array<() => void> = [];
  private locked = new Set<string>();
  private undo: Array<() => void> = [];
  constructor(state?: Memory) {
    this.state = state ?? { sequences: new Map(), reservas: new Map(), tentativas: new Map(), notas: new Map(), trilhas: new Map(), pisos: new Map(), inutilizadas: [], locks: new Map(), falharGravacao: false };
  }
  async transaction<T>(fn: (tx: NumeracaoTx) => Promise<T>): Promise<T> {
    const tx = new FakeNumeracaoRepository(this.state);
    try { return await fn(tx); }
    catch (error) { for (const undo of tx.undo.reverse()) undo(); throw error; }
    finally { for (const release of tx.releases.reverse()) release(); }
  }
  private async lock(k: string): Promise<void> {
    if (this.locked.has(k)) return;
    const previous = this.state.locks.get(k) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.state.locks.set(k, next);
    await previous;
    this.locked.add(k);
    this.releases.push(() => { if (this.state.locks.get(k) === next) this.state.locks.delete(k); release(); });
  }
  private put<T>(map: Map<string, T>, id: string, value: T): void {
    const before = copy(map.get(id));
    this.undo.push(() => { if (before === undefined) map.delete(id); else map.set(id, before); });
    map.set(id, copy(value));
  }
  async lockSequencia(userId: string, k: ChaveFiscal): Promise<Sequencia> {
    const id = key(userId, k);
    await this.lock(`seq:${id}`);
    if (!this.state.sequences.has(id)) this.put(this.state.sequences, id, { id, proximoNumero: 1 });
    return copy(this.state.sequences.get(id)!);
  }
  async avancarContador(id: string, _cfc: string, proximo: number): Promise<number> {
    const row = this.state.sequences.get(id);
    if (!row) concorrencia();
    const n = Math.max(row.proximoNumero, proximo);
    this.put(this.state.sequences, id, { ...row, proximoNumero: n });
    return n;
  }
  async reservas(userId: string, nfeId: string, lock = false): Promise<Reserva[]> {
    if (lock) await this.lock(`nfe-ledger:${nfeId}`);
    const result = [...this.state.reservas.values()].filter(r => r.userId === userId && r.nfeId === nfeId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.numero - a.numero);
    if (lock) for (const r of result) await this.lock(`reserva:${r.id}`);
    return copy(result.map(r => this.state.reservas.get(r.id)!));
  }
  async reserva(userId: string, id: string, lock = false): Promise<Reserva | null> {
    if (lock) await this.lock(`reserva:${id}`);
    const r = this.state.reservas.get(id);
    return r?.userId === userId ? copy(r) : null;
  }
  async reservasNaChave(userId: string, k: ChaveFiscal, lock = false): Promise<Reserva[]> {
    const rs = [...this.state.reservas.values()].filter(r => r.userId === userId && mesma(r, k)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.numero - a.numero);
    if (lock) for (const r of rs) await this.lock(`reserva:${r.id}`);
    return copy(rs);
  }
  async inserirReserva(row: NovaReserva): Promise<Reserva> {
    const k = { cfc: row.companyFiscalConfigId, ambiente: row.ambiente, modelo: row.modelo, serie: row.serie };
    if ([...this.state.reservas.values()].some(r => (mesma(r, k) && r.numero === row.numero) || (r.nfeId === row.nfeId && ESTADOS_VIVOS.includes(r.estado) && ESTADOS_VIVOS.includes(row.estado)))) throw new Error("23505");
    const now = new Date();
    const r: Reserva = { id: randomUUID(), provedorUltimo: null, ultimaClasse: null, ultimoCStat: null, ultimoCodigoProvedor: null, motivo: null,
      requerInutilizacao: false, bloqueadoAte: null, leaseAte: null, consumidoEm: null, createdAt: now, updatedAt: now, ...row };
    this.put(this.state.reservas, r.id, r);
    return copy(r);
  }
  async transicionar(r: Reserva, estado: EstadoReserva, patch: ReservaPatch = {}): Promise<Reserva> {
    assertTransicao(r.estado, estado);
    return this.patchReserva(r, patch, estado);
  }
  atualizarReserva(r: Reserva, patch: ReservaPatch): Promise<Reserva> { return this.patchReserva(r, patch, r.estado); }
  private async patchReserva(r: Reserva, patch: ReservaPatch, estado: EstadoReserva): Promise<Reserva> {
    const atual = this.state.reservas.get(r.id);
    if (!atual || atual.userId !== r.userId || atual.estado !== r.estado || atual.updatedAt.getTime() !== r.updatedAt.getTime()) concorrencia();
    const result = { ...atual, ...patch, estado, updatedAt: new Date(Math.max(Date.now(), atual.updatedAt.getTime() + 1)) };
    this.put(this.state.reservas, r.id, result);
    return copy(result);
  }
  async ocupacao(c: ContextoReserva, numero: number) {
    return {
      emNota: [...this.state.notas.values()].some(n => n.id !== c.nfeId && n.userId === c.userId && chaveOrdenavel(n.key) === chaveOrdenavel(c.key) && n.numero === numero),
      inutilizado: this.state.inutilizadas.some(i => chaveOrdenavel(i.key) === chaveOrdenavel(c.key) && numero >= i.ini && numero <= i.fim),
      reservado: [...this.state.reservas.values()].some(r => mesma(r, c.key) && r.numero === numero),
    };
  }
  async pisoPorEvidencia(c: ContextoReserva) { return this.state.pisos.get(key(c.userId, c.key)) ?? 0; }
  async trilha(userId: string, nfeId: string) { return this.state.notas.get(nfeId)?.userId === userId ? copy(this.state.trilhas.get(nfeId) ?? []) : []; }
  async gravarNumero(c: ContextoReserva, numero: number) {
    if (this.state.falharGravacao) throw new Error("23505 injected");
    const n = this.state.notas.get(c.nfeId);
    if (!n || n.userId !== c.userId || n.status !== "VALIDATING") concorrencia();
    this.put(this.state.notas, c.nfeId, { ...n, numero, key: c.key });
  }
  async tentativas(userId: string, reservaId: string): Promise<Tentativa[]> {
    return copy([...this.state.tentativas.values()].filter(t => t.userId === userId && t.reservaId === reservaId).sort((a, b) => b.seq - a.seq));
  }
  async inserirTentativa(row: NovaTentativa): Promise<Tentativa> {
    if ([...this.state.tentativas.values()].some(t => t.reservaId === row.reservaId && t.seq === row.seq)) throw new Error("23505");
    const t: Tentativa = { id: randomUUID(), tpEmis: 1, nRec: null, fase: "TRANSMITINDO", httpStatus: null, transporte: null, cStat: null,
      codigoProvedor: null, classe: null, prova: null, mensagem: null, protocolo: null, numeroLido: null, serieLida: null, respondidaEm: null, consultadaEm: null, createdAt: new Date(), ...row };
    this.put(this.state.tentativas, t.id, t);
    return copy(t);
  }
  async atualizarTentativa(t: Tentativa, patch: TentativaPatch): Promise<Tentativa> {
    const atual = this.state.tentativas.get(t.id);
    if (!atual || atual.userId !== t.userId || atual.fase !== t.fase) concorrencia();
    const result = { ...atual, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    this.put(this.state.tentativas, t.id, result);
    return copy(result);
  }
  async atualizarNota(userId: string, nfeId: string, estados: string[], patch: NotaPatch): Promise<void> {
    const n = this.state.notas.get(nfeId);
    if (!n || n.userId !== userId || !estados.includes(n.status)) concorrencia();
    this.put(this.state.notas, nfeId, { ...n, ...patch });
  }
  async excluirRascunho(userId: string, nfeId: string): Promise<void> {
    const n = this.state.notas.get(nfeId);
    if (!n || n.userId !== userId || !["DRAFT", "REJECTED"].includes(n.status)) concorrencia();
    this.undo.push(() => this.state.notas.set(nfeId, n));
    this.state.notas.delete(nfeId);
  }
  async linhasNaFaixa(userId: string, k: ChaveFiscal, _default: boolean, ini: number, fim: number) {
    return copy([...this.state.notas.values()].filter(n => n.userId === userId && chaveOrdenavel(n.key) === chaveOrdenavel(k) && n.numero >= ini && n.numero <= fim));
  }
}
