// BLOQ-1 — inutilização V2 × número preso em nota não autorizada (serviço, repositório em memória).
//
// Antes: `avaliarFaixa` barrava QUALQUER linha da faixa fora de INUTILIZED e QUALQUER reserva fora
// de ABANDONADO, e a mensagem mandava "exclua o rascunho" — botão que a tela não tem para NF-e
// comum. O V1 inutiliza sem guarda e deixa a linha como está; 3 das 9 inutilizações ACEITAS em
// produção cobriram nº preso em nota REJECTED. Ligar a V2 para as 22 configs as recusaria.
//
// Agora:
//  - linha DRAFT/REJECTED sem reserva (legado V1) não barra; a linha fica intacta, como no V1;
//  - reserva RESERVADO/REJEITADO/BLOQUEADO pede confirmação (409 NUMERACAO_CONFIRMAR_DESCARTE);
//    confirmada, vai a ABANDONADO NA MESMA transação do guard e a nota volta a rascunho;
//  - número que pode estar (ou vai estar) na SEFAZ continua barrando, confirmado ou não.
//
// O Postgres real (SQL do guard, NfeInutilizacao, auditoria) está em
// regressao/g1-inutilizacao-legado-v2.spec.ts.

import { describe, expect, it } from "vitest";
import { NfeNumeracaoService } from "../../../app/fiscal/numeracao/numeracao.service";
import { NumeracaoError } from "../../../app/fiscal/numeracao/numeracao.errors";
import { classificarCStatSefaz } from "../../../app/fiscal/numeracao/classificacao";
import type { ContextoReserva, Reserva } from "../../../app/fiscal/numeracao/persistencia";
import { FakeNumeracaoRepository } from "../__harness__/fake-numeracao-repository";

type Ambiente = "PRODUCAO" | "HOMOLOGACAO";

function mundo(ambiente: Ambiente = "PRODUCAO") {
  const repo = new FakeNumeracaoRepository();
  const clock = new Date("2026-09-25T12:00:00Z");
  const svc = new NfeNumeracaoService(repo, () => clock, () => "12345678");
  const key = { cfc: "empresa", ambiente, modelo: "55", serie: 1 };
  const ctx = (id: string, numero = -1): ContextoReserva => {
    const c: ContextoReserva = {
      userId: "tenant", nfeId: id, key, isDefault: false,
      row: { numero, serie: 1, ambiente, companyFiscalConfigId: "empresa", status: "DRAFT" },
      providerName: "SEFAZ_DIRECT", emitenteSnapshot: {},
    };
    repo.state.notas.set(id, { id, userId: "tenant", numero, status: "VALIDATING", key });
    return c;
  };
  const start = (r: Reserva) => svc.iniciarTransmissao(r, {
    provedor: "SEFAZ_DIRECT", chaveAcesso: "1".repeat(44), dhEmi: clock, digestValue: "digest",
    xmlAssinadoPath: "/tmp/assinado.xml", conteudoSha256: "a".repeat(64), focusRef: null,
  }, 600_000);
  /** Nota emitida pela V2 e rejeitada pela SEFAZ (225): reserva REJEITADO, nota REJECTED. */
  const rejeitada = async (id: string) => {
    const r = await svc.reservarOuReutilizar(ctx(id));
    const envio = await start(r);
    const fim = await svc.registrarResposta(envio.reserva, envio.tentativa, { classificacao: classificarCStatSefaz(225) });
    expect(fim.estado).toBe("REJEITADO");
    return fim;
  };
  /** Nota que a V2 reservou e que voltou a rascunho antes de transmitir: reserva RESERVADO. */
  const reservada = async (id: string) => {
    const r = await svc.reservarOuReutilizar(ctx(id));
    repo.state.notas.get(id)!.status = "DRAFT";
    return r;
  };
  /** Linha legada do V1: número positivo em nota REJECTED, sem nenhuma reserva. */
  const legadaV1 = (id: string, numero: number, status = "REJECTED") => {
    repo.state.notas.set(id, { id, userId: "tenant", numero, status, key, cStatRejeicao: 225, motivoRejeicao: "Rejeicao: legado" });
  };
  const pendentes: string[] = [];
  const guard = (ini: number, fim: number, opts?: { confirmarDescarte?: boolean; actorUserId?: string }) =>
    svc.inutilizacaoGuard("tenant", key, false, ini, fim, async () => { pendentes.push(`${ini}-${fim}`); return "PENDENTE"; }, opts);
  const contador = () => [...repo.state.sequences.values()][0]?.proximoNumero;
  return { repo, svc, key, ctx, start, rejeitada, reservada, legadaV1, guard, pendentes, contador };
}

async function erroDe(p: Promise<unknown>): Promise<NumeracaoError> {
  try { await p; } catch (e) { return e as NumeracaoError; }
  throw new Error("esperava uma rejeição, mas a promessa resolveu");
}

describe("legado V1: linha DRAFT/REJECTED sem reserva não barra a inutilização", () => {
  it.each([["REJECTED"], ["DRAFT"]])("linha %s nº 5 ⇒ passa sem confirmação e a linha fica intacta", async (status) => {
    const w = mundo();
    w.legadaV1("legada", 5, status);
    const antes = structuredClone(w.repo.state.notas.get("legada"));

    expect(await w.guard(5, 5)).toBe("PENDENTE");
    expect(w.pendentes).toEqual(["5-5"]);
    expect(w.repo.state.notas.get("legada")).toEqual(antes);
    expect(w.repo.state.reservas.size).toBe(0);
  });
});

describe("reserva RESERVADO/REJEITADO na faixa: confirmação explícita", () => {
  it("SEM confirmação ⇒ 409 NUMERACAO_CONFIRMAR_DESCARTE {numeros, serie}; nada registrado nem mudado", async () => {
    const w = mundo();
    const r = await w.rejeitada("x");
    const notaAntes = structuredClone(w.repo.state.notas.get("x"));

    const erro = await erroDe(w.guard(r.numero, r.numero + 2));
    expect(erro).toBeInstanceOf(NumeracaoError);
    expect(erro).toMatchObject({ code: "NUMERACAO_CONFIRMAR_DESCARTE", httpStatus: 409 });
    expect(erro.detalhes).toEqual({ numeros: [r.numero], serie: 1 });
    expect(erro.message).not.toMatch(/exclua|excluir/i);

    expect(w.pendentes).toEqual([]);
    expect(w.repo.state.reservas.get(r.id)!.estado).toBe("REJEITADO");
    expect(w.repo.state.notas.get("x")).toEqual(notaAntes);
  });

  it("COM confirmação ⇒ ABANDONADO na mesma transação, nota volta a DRAFT com placeholder (cStat/motivo preservados)", async () => {
    const w = mundo();
    const r = await w.rejeitada("x");
    const motivo = w.repo.state.notas.get("x")!.motivoRejeicao;

    expect(await w.guard(r.numero, r.numero, { confirmarDescarte: true })).toBe("PENDENTE");

    expect(w.repo.state.reservas.get(r.id)).toMatchObject({
      estado: "ABANDONADO", motivo: "INUTILIZACAO_CONFIRMADA", requerInutilizacao: true,
    });
    const nota = w.repo.state.notas.get("x")!;
    expect(nota.status).toBe("DRAFT");
    expect(nota.numero).toBeLessThan(0);
    expect(nota.cStatRejeicao).toBe(225);
    expect(nota.motivoRejeicao).toBe(motivo);
    expect(nota.chaveAcesso).toBeNull();
  });

  it("inutilização ACEITA: inutilizacaoPos leva a INUTILIZADO, contador vai a GREATEST(fim+1) e a reemissão pega número novo", async () => {
    const w = mundo();
    const r = await w.rejeitada("x");            // nº 1, contador 2
    await w.guard(1, 3, { confirmarDescarte: true });
    await w.svc.inutilizacaoPos("tenant", w.key, false, 1, 3);

    expect(w.repo.state.reservas.get(r.id)).toMatchObject({ estado: "INUTILIZADO", requerInutilizacao: false });
    expect(w.contador()).toBe(4);

    // "Emitir" de novo a MESMA nota: placeholder ⇒ contador, nunca o nº inutilizado.
    const nota = w.repo.state.notas.get("x")!;
    const c = w.ctx("x", nota.numero);
    const nova = await w.svc.reservarOuReutilizar(c);
    expect(nova).toMatchObject({ numero: 4, origemDecisao: "CONTADOR" });
  });

  it("inutilização REJEITADA pela SEFAZ: a reserva fica ABANDONADO com requerInutilizacao e o nº não volta ao pool", async () => {
    const w = mundo();
    const r = await w.rejeitada("x");            // nº 1
    await w.guard(1, 1, { confirmarDescarte: true });
    // (sem inutilizacaoPos: a SEFAZ recusou)
    expect(w.repo.state.reservas.get(r.id)).toMatchObject({ estado: "ABANDONADO", requerInutilizacao: true });

    const nota = w.repo.state.notas.get("x")!;
    const nova = await w.svc.reservarOuReutilizar(w.ctx("x", nota.numero));
    expect(nova.numero).toBe(2);
    // E outra nota também não recebe o 1.
    expect((await w.svc.reservarOuReutilizar(w.ctx("y"))).numero).toBe(3);
  });

  it("HOMOLOGAÇÃO: também confirma; ABANDONADO sem requerInutilizacao", async () => {
    const w = mundo("HOMOLOGACAO");
    const r = await w.reservada("x");
    await expect(w.guard(r.numero, r.numero)).rejects.toMatchObject({ code: "NUMERACAO_CONFIRMAR_DESCARTE" });
    await w.guard(r.numero, r.numero, { confirmarDescarte: true });
    expect(w.repo.state.reservas.get(r.id)).toMatchObject({ estado: "ABANDONADO", requerInutilizacao: false });
    expect(w.repo.state.notas.get("x")).toMatchObject({ status: "DRAFT" });
  });

  it("falha ao registrar a PENDENTE desfaz o descarte (mesma transação)", async () => {
    const w = mundo();
    const r = await w.rejeitada("x");
    const notaAntes = structuredClone(w.repo.state.notas.get("x"));
    await expect(w.svc.inutilizacaoGuard("tenant", w.key, false, r.numero, r.numero, async () => { throw new Error("INSERT falhou"); }, { confirmarDescarte: true }))
      .rejects.toThrow("INSERT falhou");
    expect(w.repo.state.reservas.get(r.id)!.estado).toBe("REJEITADO");
    expect(w.repo.state.notas.get("x")).toEqual(notaAntes);
  });

  it("nota renumerada DENTRO da própria faixa (nº 2, reserva no 1): só a reserva é descartada; a nota segue no 2", async () => {
    const w = mundo();
    const r = await w.reservada("x");           // reserva nº 1
    w.repo.state.notas.get("x")!.numero = 2;    // a nota hoje segura o 2 (sem reserva: legado)
    await w.guard(1, 2, { confirmarDescarte: true });
    expect(w.repo.state.reservas.get(r.id)!.estado).toBe("ABANDONADO");
    expect(w.repo.state.notas.get("x")).toMatchObject({ status: "DRAFT", numero: 2 });
  });

  it("reserva cuja nota já não está na faixa (outro número): a reserva é descartada e a nota não é tocada", async () => {
    const w = mundo();
    const r = await w.reservada("x");
    w.repo.state.notas.get("x")!.numero = 900; // nota renumerada por fora (ex.: V1 depois de rollback)
    const antes = structuredClone(w.repo.state.notas.get("x"));
    await w.guard(r.numero, r.numero, { confirmarDescarte: true });
    expect(w.repo.state.reservas.get(r.id)!.estado).toBe("ABANDONADO");
    expect(w.repo.state.notas.get("x")).toEqual(antes);
  });
});

describe("BLOQUEADO na faixa: confirmação de que o nº NÃO foi autorizado", () => {
  it("sem confirmação o texto pede a conferência; confirmado vai a ABANDONADO e a nota volta a DRAFT", async () => {
    const w = mundo();
    const r = await w.rejeitada("x");
    // Retido para conferência (613 sem chave referida legível), como o orquestrador faz.
    const bloqueada = { ...w.repo.state.reservas.get(r.id)!, estado: "BLOQUEADO" as const };
    w.repo.state.reservas.set(r.id, bloqueada);

    const erro = await erroDe(w.guard(r.numero, r.numero));
    expect(erro).toMatchObject({ code: "NUMERACAO_CONFIRMAR_DESCARTE", httpStatus: 409 });
    expect(erro.message).toContain("NÃO foi autorizado na SEFAZ");
    expect(erro.detalhes).toEqual({ numeros: [r.numero], serie: 1 });

    await w.guard(r.numero, r.numero, { confirmarDescarte: true });
    expect(w.repo.state.reservas.get(r.id)!.estado).toBe("ABANDONADO");
    expect(w.repo.state.notas.get("x")).toMatchObject({ status: "DRAFT", cStatRejeicao: 225 });
  });
});

describe("o que pode estar (ou vai estar) na SEFAZ continua barrando — confirmado ou não", () => {
  it("reserva INCERTO ⇒ FAIXA_COM_NUMERO_VIVO (400)", async () => {
    const w = mundo();
    const r = await w.svc.reservarOuReutilizar(w.ctx("x"));
    const envio = await w.start(r);
    const incerta = await w.svc.devolverIncerto(envio.reserva);
    for (const confirmarDescarte of [false, true]) {
      await expect(w.guard(r.numero, r.numero, { confirmarDescarte })).rejects.toMatchObject({ code: "FAIXA_COM_NUMERO_VIVO", httpStatus: 400 });
    }
    expect(w.repo.state.reservas.get(r.id)!.estado).toBe(incerta.estado);
    expect(w.pendentes).toEqual([]);
  });

  it("linha SENDING legada (sem reserva) ⇒ FAIXA_COM_NUMERO_VIVO", async () => {
    const w = mundo();
    w.legadaV1("em-voo", 5, "SENDING");
    await expect(w.guard(5, 5, { confirmarDescarte: true })).rejects.toMatchObject({ code: "FAIXA_COM_NUMERO_VIVO" });
  });

  it("emissão em curso (nota VALIDATING com reserva RESERVADO) ⇒ FAIXA_COM_NUMERO_VIVO, a reserva não é tocada", async () => {
    const w = mundo();
    const r = await w.svc.reservarOuReutilizar(w.ctx("x")); // nota segue VALIDATING
    await expect(w.guard(r.numero, r.numero, { confirmarDescarte: true })).rejects.toMatchObject({ code: "FAIXA_COM_NUMERO_VIVO" });
    expect(w.repo.state.reservas.get(r.id)!.estado).toBe("RESERVADO");
  });

  it("faixa mista (REJEITADO + AUTHORIZED) ⇒ o bloqueio prevalece e nenhum descarte é aplicado", async () => {
    const w = mundo();
    const r = await w.rejeitada("x");            // nº 1
    w.legadaV1("autorizada", 2, "AUTHORIZED");
    const erro = await erroDe(w.guard(1, 2, { confirmarDescarte: true }));
    expect(erro).toMatchObject({ code: "FAIXA_COM_NUMERO_VIVO", httpStatus: 400 });
    expect(erro.message).toContain("nº 2");
    expect(w.repo.state.reservas.get(r.id)!.estado).toBe("REJEITADO");
    expect(w.repo.state.notas.get("x")).toMatchObject({ status: "REJECTED", numero: 1 });
  });
});
