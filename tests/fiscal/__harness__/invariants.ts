/**
 * Invariantes globais da numeração, verificáveis sobre o estado do harness.
 * Funções PURAS: recebem o estado e devolvem a lista de violações (vazia = ok).
 * `emit-world.ts` expõe `checarInvariantes()`/`assertInvariantes()` por cima.
 *
 * Cobertas aqui (as que valem também para o V1 legado):
 *  - I1  nenhuma NfeEmitida compartilha (emitente, ambiente, série, modelo, número>0);
 *  - I2  a autoridade nunca autorizou o mesmo nfeId duas vezes;
 *  - I5  `NfeSequence.proximoNumero` nunca diminui (sem `numero--`);
 *  - I3v1 toda nota AUTHORIZED tem chave que a autoridade conhece como
 *        autorizada/cancelada, e o nNF da chave é o `numero` da linha.
 * As invariantes da numeração V2 (reserva × consumo) entram quando o fake V2
 * existir.
 */

import type { InMemoryDb } from "./in-memory-prisma";
import type { FakeAuthority } from "./fake-authority";

export function violacoesNumerosUnicos(db: InMemoryDb): string[] {
  const vistos = new Map<string, string>();
  const out: string[] = [];
  for (const l of db.tabela("nfeEmitida")) {
    if (!(Number(l.numero) > 0)) continue;
    const dono = l.companyFiscalConfigId ?? `user:${l.userId}`;
    const k = [dono, l.ambiente, l.serie, l.modelo, l.numero].join("|");
    const outro = vistos.get(k);
    if (outro) out.push(`I1: número ${l.numero} (${k}) em ${outro} e ${l.id}`);
    else vistos.set(k, l.id);
  }
  return out;
}

export function violacoesContadorMonotono(db: InMemoryDb): string[] {
  const out: string[] = [];
  for (const e of db.escritas("nfeSequence")) {
    if (e.operacao !== "update" || !e.antes || !e.depois) continue;
    if (Number(e.depois.proximoNumero) < Number(e.antes.proximoNumero)) {
      out.push(
        `I5: NfeSequence ${e.id} recuou de ${e.antes.proximoNumero} para ${e.depois.proximoNumero}`,
      );
    }
  }
  return out;
}

export function violacoesAutoridade(authority: FakeAuthority): string[] {
  const out: string[] = [];
  const porNfe = new Map<string, number>();
  for (const r of authority.registros()) {
    if (!r.nfeId || (r.estado !== "autorizada" && r.estado !== "cancelada")) continue;
    porNfe.set(r.nfeId, (porNfe.get(r.nfeId) ?? 0) + 1);
  }
  for (const [nfeId, n] of porNfe) {
    if (n > 1) out.push(`I2: nfeId ${nfeId} autorizado ${n} vezes na autoridade`);
  }
  return out;
}

export function violacoesAutorizadasNaAutoridade(
  db: InMemoryDb,
  authority: FakeAuthority,
): string[] {
  const out: string[] = [];
  for (const l of db.tabela("nfeEmitida")) {
    if (l.status !== "AUTHORIZED" && l.status !== "CANCELLED") continue;
    const chave = String(l.chaveAcesso ?? "").replace(/\D/g, "");
    if (chave.length !== 44) {
      out.push(`I3v1: ${l.id} ${l.status} sem chave de 44 dígitos`);
      continue;
    }
    const r = authority.consultarPorChave(chave);
    if (r.cStat !== 100 && r.cStat !== 101) {
      out.push(`I3v1: ${l.id} ${l.status} com chave que a autoridade não conhece (cStat ${r.cStat})`);
      continue;
    }
    const nNF = Number(chave.slice(25, 34));
    if (nNF !== Number(l.numero)) {
      out.push(`I3v1: ${l.id} numero ${l.numero} ≠ nNF ${nNF} da chave`);
    }
  }
  return out;
}

export function todasViolacoes(db: InMemoryDb, authority: FakeAuthority): string[] {
  return [
    ...violacoesNumerosUnicos(db),
    ...violacoesContadorMonotono(db),
    ...violacoesAutoridade(authority),
    ...violacoesAutorizadasNaAutoridade(db, authority),
  ];
}
