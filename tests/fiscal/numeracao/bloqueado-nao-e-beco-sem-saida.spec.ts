// Regressão: reserva BLOQUEADA não pode ser um beco sem saída.
//
// Becos fechados por esta suíte (ambos só existem na V2):
//  1. `aplicarResultado` pulava a atualização da NOTA quando o alvo era BLOQUEADO
//     (`alvo !== "INCERTO" && alvo !== "BLOQUEADO"`), então a nota ficava em SENDING:
//     sumia do wizard (findDraftById só enxerga DRAFT/REJECTED), `consultar` não a
//     alcançava (BLOQUEADO não é estado consultável) e `emitir` respondia 409
//     NUMERACAO_BLOQUEADA. Só SQL em produção destravava.
//  2. `TRANSICOES.BLOQUEADO = []` — nenhum caminho de código tirava a reserva de lá,
//     e `abandonarPorExclusao` ainda barrava antes, com 409 NFE_NUMERO_PENDENTE_CONSULTA
//     ("Consulte a situação antes de excluir"), para um estado em que consultar de novo
//     não move nada: a SEFAZ JÁ respondeu, o que falta é conferência humana.
//
// O gatilho real é o cStat 613 ("Chave de Acesso difere da existente em BD"), cuja
// mensagem nunca traz chave de 44 dígitos — o que torna o ramo BLOQUEADO do orquestrador
// DETERMINÍSTICO para ele. A DLS AUTO PEÇAS, já na V2, recebeu um 613 no nº 501.
//
// O que a correção NÃO faz: BLOQUEADO continua sem saída automática. A única aresta nova
// é BLOQUEADO → ABANDONADO, percorrida só com descarte CONFIRMADO: pela exclusão do
// rascunho, (c) pelo descarte do número sem excluir a nota, ou pela inutilização da faixa
// (g1-inutilizacao-descarte.spec.ts). BLOQUEADO → RESERVADO segue proibida de propósito
// (devolveria ao pool de reuso um número que pode estar autorizado na SEFAZ com outro cNF).

import { describe, it, expect } from "vitest";
import { NfeNumeracaoService } from "../../../app/fiscal/numeracao/numeracao.service";
import { NumeracaoError } from "../../../app/fiscal/numeracao/numeracao.errors";
import { podeTransicionar } from "../../../app/fiscal/numeracao/estados";
import {
  classificarCStatSefaz,
  extrairChaveReferida,
} from "../../../app/fiscal/numeracao/classificacao";
import { partesDaChave } from "../../../app/fiscal/numeracao/decisao";
import type { Classificacao } from "../../../app/fiscal/numeracao/tipos";
import type { ContextoReserva, Reserva } from "../../../app/fiscal/numeracao/persistencia";
import { FakeNumeracaoRepository } from "../__harness__/fake-numeracao-repository";

/** xMotivo real do 613 — repare que NÃO há chave de 44 dígitos nele. */
const XMOTIVO_613 = "Rejeicao: Chave de Acesso difere da existente em BD";

function mundo(ambiente: "PRODUCAO" | "HOMOLOGACAO" = "PRODUCAO") {
  const repo = new FakeNumeracaoRepository();
  const clock = new Date("2026-09-23T12:00:00Z");
  const svc = new NfeNumeracaoService(repo, () => clock, () => "12345678");
  const ctx = (id: string): ContextoReserva => {
    const c: ContextoReserva = {
      userId: "tenant", nfeId: id, key: { cfc: "empresa", ambiente, modelo: "55", serie: 1 },
      isDefault: false, row: { numero: -1, serie: 1, ambiente, companyFiscalConfigId: "empresa", status: "DRAFT" },
      providerName: "SEFAZ_DIRECT", emitenteSnapshot: {},
    };
    repo.state.notas.set(id, { id, userId: c.userId, numero: c.row.numero, status: "VALIDATING", key: c.key });
    return c;
  };
  const start = (r: Reserva) => svc.iniciarTransmissao(r, {
    provedor: "SEFAZ_DIRECT", chaveAcesso: "1".repeat(44), dhEmi: clock, digestValue: "digest",
    xmlAssinadoPath: "/tmp/assinado.xml", conteudoSha256: "a".repeat(64), focusRef: null,
  }, 600_000);
  return { repo, svc, ctx, start };
}

/**
 * A reescrita que o orquestrador faz no ramo DUPLICIDADE_OUTRA_CHAVE quando não há chave
 * referida consistente (nfe-emissao-v2.orchestrator.ts, `consultar`). `cStat` vem da
 * resposta real e é repassado — nada é inventado aqui.
 */
const bloqueioPorDuplicidade = (base: Classificacao): Classificacao => ({
  ...base,
  estadoAlvo: "BLOQUEADO",
  conclusiva: false,
  mensagem: "Duplicidade sem chave fiscal consistente — conferência manual",
});

/** Captura a rejeição de uma promessa `void`, com o tipo certo. */
async function erroDe(p: Promise<unknown>): Promise<NumeracaoError> {
  try { await p; } catch (e) { return e as NumeracaoError; }
  throw new Error("esperava uma rejeição, mas a promessa resolveu");
}

/** Leva uma nota nova até a reserva BLOQUEADA pelo caminho do 613. */
async function ateOBloqueio(w: ReturnType<typeof mundo>, id: string) {
  const c = w.ctx(id);
  const reserva = await w.svc.reservarOuReutilizar(c);
  const envio = await w.start(reserva);
  const seiscentosTreze = classificarCStatSefaz(613, { xMotivo: XMOTIVO_613 });

  // Envio: o 613 não decide estado sozinho (estadoAlvo null) — a reserva vai a INCERTO e a
  // nota FICA em SENDING, porque de fato ainda está em andamento. Isso é correto.
  const incerta = await w.svc.registrarResposta(envio.reserva, envio.tentativa, { classificacao: seiscentosTreze });
  expect(incerta.estado).toBe("INCERTO");
  expect(w.repo.state.notas.get(id)).toMatchObject({ status: "SENDING" });

  // Consulta: sem chave referida legível o orquestrador retém o número para conferência.
  const bloqueada = await w.svc.registrarConsulta(incerta, envio.tentativa, {
    classificacao: bloqueioPorDuplicidade(seiscentosTreze),
  });
  expect(bloqueada.estado).toBe("BLOQUEADO");
  return { reserva: bloqueada, numero: reserva.numero };
}

describe("613 sem chave referida: o ramo BLOQUEADO é determinístico", () => {
  it("a mensagem do 613 não carrega chave de 44 dígitos, então a identidade nunca confere", () => {
    const cls = classificarCStatSefaz(613, { xMotivo: XMOTIVO_613 });
    expect(cls.classe).toBe("DUPLICIDADE_OUTRA_CHAVE");
    expect(cls.cStat).toBe(613);
    // Estes dois são exatamente os insumos de `mesmaIdentidade` no orquestrador.
    expect(extrairChaveReferida(cls.mensagem)).toBeNull();
    expect(extrairChaveReferida(XMOTIVO_613)).toBeNull();
    expect(partesDaChave(null)).toBeNull();
  });
});

describe("(a) alvo BLOQUEADO tira a nota de SENDING", () => {
  it("a nota termina REJECTED, visível, com o cStat REAL da duplicidade e motivo de retenção", async () => {
    const w = mundo();
    const { numero } = await ateOBloqueio(w, "dls-501");

    const nota = w.repo.state.notas.get("dls-501")!;
    expect(nota.status).not.toBe("SENDING");
    expect(nota.status).toBe("REJECTED");
    // 613 é o que a SEFAZ devolveu: preservado, não inventado e não apagado.
    expect(nota.cStatRejeicao).toBe(613);
    expect(String(nota.motivoRejeicao)).toContain(`Nº ${numero}`);
    expect(String(nota.motivoRejeicao)).toContain("conferência");
  });

  it("REJECTED aqui não reabre a emissão: a reserva BLOQUEADA continua sem saída automática", async () => {
    const w = mundo();
    const { reserva } = await ateOBloqueio(w, "dls-501");

    // Nenhuma rotina tira a reserva de BLOQUEADO: as que escrevem estado exigem reserva
    // aberta (EM_TRANSMISSAO/INCERTO) ou reusável.
    expect(await w.svc.tomarLease("tenant", reserva.id, 600_000)).toBeNull();
    await expect(w.svc.devolverIncerto(reserva)).rejects.toMatchObject({ code: "NUMERACAO_CONCORRENCIA" });
    await expect(w.svc.naoConstaConfirmado(reserva)).rejects.toMatchObject({ code: "NUMERACAO_CONCORRENCIA" });
    expect(podeTransicionar("BLOQUEADO", "RESERVADO")).toBe(false);
    expect(podeTransicionar("BLOQUEADO", "EM_TRANSMISSAO")).toBe(false);
    expect(podeTransicionar("BLOQUEADO", "AUTORIZADO")).toBe(false);
  });

  it("INCERTO continua deixando a nota em SENDING (a correção não vazou para o alvo vizinho)", async () => {
    const w = mundo();
    const c = w.ctx("ainda-incerta");
    const reserva = await w.svc.reservarOuReutilizar(c);
    const envio = await w.start(reserva);
    await w.svc.registrarResposta(envio.reserva, envio.tentativa, { classificacao: classificarCStatSefaz(613, { xMotivo: XMOTIVO_613 }) });
    expect(w.repo.state.notas.get("ainda-incerta")).toMatchObject({ status: "SENDING" });
  });
});

describe("(b) a reserva BLOQUEADA só é encerrada pelo caminho humano com confirmação", () => {
  it("SEM confirmação: 409 NUMERACAO_CONFIRMAR_DESCARTE, reserva e rascunho intactos", async () => {
    const w = mundo();
    const { reserva, numero } = await ateOBloqueio(w, "dls-501");

    await expect(w.svc.abandonarPorExclusao("tenant", "dls-501", false)).rejects.toMatchObject({
      code: "NUMERACAO_CONFIRMAR_DESCARTE", httpStatus: 409,
    });
    const erro = await erroDe(w.svc.abandonarPorExclusao("tenant", "dls-501", false));
    expect(erro.message).toContain("retido para conferência");
    expect(erro.message).toContain("NÃO foi autorizado na SEFAZ");

    expect(w.repo.state.reservas.get(reserva.id)!.estado).toBe("BLOQUEADO");
    expect(w.repo.state.notas.has("dls-501")).toBe(true);
    expect(numero).toBeGreaterThan(0);
  });

  it("COM confirmação: vai a ABANDONADO, marca requerInutilizacao e exclui o rascunho", async () => {
    const w = mundo();
    const { reserva } = await ateOBloqueio(w, "dls-501");

    await w.svc.abandonarPorExclusao("tenant", "dls-501", true);

    const final = w.repo.state.reservas.get(reserva.id)!;
    expect(final.estado).toBe("ABANDONADO");
    expect(final.motivo).toBe("RASCUNHO_EXCLUIDO");
    // Produção: o número descartado tem de ser inutilizado. Se ele ESTIVER autorizado na
    // SEFAZ a inutilização falha — falha segura, ao contrário de reemitir em cima dele.
    expect(final.requerInutilizacao).toBe(true);
    expect(w.repo.state.notas.has("dls-501")).toBe(false);
    // ABANDONADO → INUTILIZADO segue sendo a única continuação.
    expect(podeTransicionar("ABANDONADO", "INUTILIZADO")).toBe(true);
    expect(podeTransicionar("ABANDONADO", "RESERVADO")).toBe(false);
  });

  it("a confirmação é exigida também em HOMOLOGAÇÃO (o bloqueio não é um descarte de rotina)", async () => {
    const w = mundo("HOMOLOGACAO");
    const { reserva } = await ateOBloqueio(w, "homolog-1");

    await expect(w.svc.abandonarPorExclusao("tenant", "homolog-1", false)).rejects.toMatchObject({
      code: "NUMERACAO_CONFIRMAR_DESCARTE",
    });
    expect(w.repo.state.reservas.get(reserva.id)!.estado).toBe("BLOQUEADO");

    await w.svc.abandonarPorExclusao("tenant", "homolog-1", true);
    const final = w.repo.state.reservas.get(reserva.id)!;
    expect(final.estado).toBe("ABANDONADO");
    // Fora de produção não há inutilização a fazer.
    expect(final.requerInutilizacao).toBe(false);
  });

  it("RESERVADO em produção continua pedindo confirmação com a mensagem antiga (sem regressão)", async () => {
    const w = mundo();
    const c = w.ctx("so-reservada");
    await w.svc.reservarOuReutilizar(c);
    w.repo.state.notas.get("so-reservada")!.status = "DRAFT";

    const erro = await erroDe(w.svc.abandonarPorExclusao("tenant", "so-reservada", false));
    expect(erro).toBeInstanceOf(NumeracaoError);
    expect(erro.code).toBe("NUMERACAO_CONFIRMAR_DESCARTE");
    expect(erro.message).toContain("ficará sem uso e precisará ser inutilizado");
  });

  it("INCERTO continua barrada na exclusão com NFE_NUMERO_PENDENTE_CONSULTA (consultar ainda resolve)", async () => {
    const w = mundo();
    const c = w.ctx("incerta");
    const reserva = await w.svc.reservarOuReutilizar(c);
    const envio = await w.start(reserva);
    const incerta = await w.svc.registrarResposta(envio.reserva, envio.tentativa, { classificacao: classificarCStatSefaz(613, { xMotivo: XMOTIVO_613 }) });
    expect(incerta.estado).toBe("INCERTO");

    // Confirmar descarte NÃO pode abrir atalho para um estado que ainda tem consulta pendente.
    await expect(w.svc.abandonarPorExclusao("tenant", "incerta", true)).rejects.toMatchObject({
      code: "NFE_NUMERO_PENDENTE_CONSULTA", httpStatus: 409,
    });
    expect(w.repo.state.reservas.get(reserva.id)!.estado).toBe("INCERTO");
  });
});

// BLOQ-2 (paridade com o V1): a exclusão do rascunho era a ÚNICA saída do BLOQUEADO, e a tela
// só a alcança nos quadros de devolução. NF-e comum retida por 613 morria ali — no V1 a mesma
// nota seria reemitida com número novo. `descartarNumeroBloqueado` descarta SÓ o número: a nota
// fica, volta a rascunho (placeholder) com o cStat/motivo da retenção, e "Emitir" reserva outro.
describe("(c) descartarNumeroBloqueado: descarta o nº retido SEM excluir a nota", () => {
  it("COM confirmação: X vai a ABANDONADO, a nota volta a DRAFT e emitir o MESMO nfeId recebe X+1", async () => {
    const w = mundo();
    const { reserva, numero } = await ateOBloqueio(w, "dls-501");

    const r = await w.svc.descartarNumeroBloqueado("tenant", "dls-501", true);
    expect(r).toEqual({ numero, serie: 1 });

    const final = w.repo.state.reservas.get(reserva.id)!;
    expect(final.estado).toBe("ABANDONADO");
    expect(final.requerInutilizacao).toBe(true); // produção: o nº descartado tem de ser inutilizado
    expect(final.motivo).toBe("NUMERO_RETIDO_DESCARTADO");

    // A nota NÃO foi excluída: rascunho com placeholder, cStat e motivo da retenção preservados.
    const nota = w.repo.state.notas.get("dls-501")!;
    expect(nota.status).toBe("DRAFT");
    expect(nota.numero).toBeLessThan(0);
    expect(nota.cStatRejeicao).toBe(613);
    expect(String(nota.motivoRejeicao)).toContain(`Nº ${numero} retido para conferência`);
    expect(nota.chaveAcesso).toBeNull();

    // "Emitir" de novo: o claim põe a nota em VALIDATING e a reserva sai do CONTADOR (X+1).
    nota.status = "VALIDATING";
    const c = w.ctx("dls-501");
    const nova = await w.svc.reservarOuReutilizar({ ...c, row: { ...c.row, numero: nota.numero, status: "DRAFT" } });
    expect(nova).toMatchObject({ numero: numero + 1, origemDecisao: "CONTADOR", estado: "RESERVADO" });
    expect(w.repo.state.reservas.get(reserva.id)!.estado).toBe("ABANDONADO");
    expect((await w.svc.reservaViva("tenant", "dls-501"))!.id).toBe(nova.id);
  });

  it("SEM confirmação: 409 NUMERACAO_CONFIRMAR_DESCARTE com número e série — nada muda", async () => {
    const w = mundo();
    const { reserva, numero } = await ateOBloqueio(w, "dls-501");
    const notaAntes = structuredClone(w.repo.state.notas.get("dls-501"));

    const erro = await erroDe(w.svc.descartarNumeroBloqueado("tenant", "dls-501", false));
    expect(erro).toBeInstanceOf(NumeracaoError);
    expect(erro).toMatchObject({ code: "NUMERACAO_CONFIRMAR_DESCARTE", httpStatus: 409 });
    expect(erro.detalhes).toMatchObject({ numero, serie: 1 });
    expect(erro.message).toContain("NÃO foi autorizado na SEFAZ");

    expect(w.repo.state.reservas.get(reserva.id)!.estado).toBe("BLOQUEADO");
    expect(w.repo.state.notas.get("dls-501")).toEqual(notaAntes);
  });

  it("HOMOLOGAÇÃO também exige confirmação; confirmado, não marca requerInutilizacao", async () => {
    const w = mundo("HOMOLOGACAO");
    const { reserva } = await ateOBloqueio(w, "homolog-1");
    await expect(w.svc.descartarNumeroBloqueado("tenant", "homolog-1")).rejects.toMatchObject({ code: "NUMERACAO_CONFIRMAR_DESCARTE" });
    await w.svc.descartarNumeroBloqueado("tenant", "homolog-1", true);
    expect(w.repo.state.reservas.get(reserva.id)).toMatchObject({ estado: "ABANDONADO", requerInutilizacao: false });
  });

  it("nota legada ainda em SENDING com a reserva BLOQUEADA (antes da correção (a)) também sai pelo descarte", async () => {
    const w = mundo();
    const { reserva } = await ateOBloqueio(w, "legado-sending");
    w.repo.state.notas.get("legado-sending")!.status = "SENDING";
    await w.svc.descartarNumeroBloqueado("tenant", "legado-sending", true);
    expect(w.repo.state.reservas.get(reserva.id)!.estado).toBe("ABANDONADO");
    expect(w.repo.state.notas.get("legado-sending")).toMatchObject({ status: "DRAFT" });
  });

  it.each([["RESERVADO"], ["REJEITADO"], ["INCERTO"]])(
    "reserva viva em %s (não BLOQUEADO) ⇒ 409 NUMERACAO_NAO_BLOQUEADA, mesmo confirmando — nada muda",
    async (estado) => {
      const w = mundo();
      const c = w.ctx("outra");
      const r = await w.svc.reservarOuReutilizar(c);
      if (estado === "REJEITADO") {
        const envio = await w.start(r);
        await w.svc.registrarResposta(envio.reserva, envio.tentativa, { classificacao: classificarCStatSefaz(225) });
      } else if (estado === "INCERTO") {
        const envio = await w.start(r);
        await w.svc.registrarResposta(envio.reserva, envio.tentativa, { classificacao: classificarCStatSefaz(613, { xMotivo: XMOTIVO_613 }) });
      } else {
        w.repo.state.notas.get("outra")!.status = "DRAFT";
      }
      expect(w.repo.state.reservas.get(r.id)!.estado).toBe(estado);
      const notaAntes = structuredClone(w.repo.state.notas.get("outra"));

      for (const confirmar of [false, true]) {
        await expect(w.svc.descartarNumeroBloqueado("tenant", "outra", confirmar)).rejects.toMatchObject({
          code: "NUMERACAO_NAO_BLOQUEADA", httpStatus: 409,
        });
      }
      expect(w.repo.state.reservas.get(r.id)!.estado).toBe(estado);
      expect(w.repo.state.notas.get("outra")).toEqual(notaAntes);
    },
  );

  it("nota sem reserva viva ⇒ 409 NUMERACAO_NAO_BLOQUEADA", async () => {
    const w = mundo();
    w.repo.state.notas.set("sem-reserva", { id: "sem-reserva", userId: "tenant", numero: -1, status: "DRAFT", key: { cfc: "empresa", ambiente: "PRODUCAO", modelo: "55", serie: 1 } });
    await expect(w.svc.descartarNumeroBloqueado("tenant", "sem-reserva", true)).rejects.toMatchObject({ code: "NUMERACAO_NAO_BLOQUEADA", httpStatus: 409 });
  });

  it("outro tenant não enxerga a reserva: NUMERACAO_NAO_BLOQUEADA e a reserva segue BLOQUEADA", async () => {
    const w = mundo();
    const { reserva } = await ateOBloqueio(w, "dls-501");
    await expect(w.svc.descartarNumeroBloqueado("intruso", "dls-501", true)).rejects.toMatchObject({ code: "NUMERACAO_NAO_BLOQUEADA" });
    expect(w.repo.state.reservas.get(reserva.id)!.estado).toBe("BLOQUEADO");
  });
});
