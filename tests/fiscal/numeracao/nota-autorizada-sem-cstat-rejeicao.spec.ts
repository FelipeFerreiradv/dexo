// Regressão: nota AUTORIZADA não pode carregar o cStat da tentativa rejeitada.
//
// Observado em produção (DLS AUTO PEÇAS, 23/09/2026): a nota 710 autorizou na 3ª
// tentativa (232, 232, 100) mantendo número e chave, e ficou AUTHORIZED com
// protocolo, `motivoRejeicao` NULL — e `cStatRejeicao` = 232, resto da 1ª tentativa.
//
// A assimetria é de origem: o claim da reemissão (nfe-emissao-v2.orchestrator.ts)
// limpa `motivoRejeicao` e NÃO limpa `cStatRejeicao`, então o cStat sobrevive até a
// nota voltar para SENDING. Quem tem de apagá-lo é o patch de AUTORIZAÇÃO, no
// instante em que o campo fica indiscutivelmente errado (numeracao.service.ts).

import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { NfeNumeracaoService } from "../../../app/fiscal/numeracao/numeracao.service";
import { NfeNumeracaoRepository } from "../../../app/fiscal/numeracao/numeracao.repository";
import { classificarCStatSefaz } from "../../../app/fiscal/numeracao/classificacao";
import type { ContextoReserva, Reserva } from "../../../app/fiscal/numeracao/persistencia";
import { FakeNumeracaoRepository } from "../__harness__/fake-numeracao-repository";

const PROTOCOLO = "242260451012429";

function mundo() {
  const repo = new FakeNumeracaoRepository();
  const clock = new Date("2026-09-23T12:00:00Z");
  const svc = new NfeNumeracaoService(repo, () => clock, () => "12345678");
  const ctx = (id: string): ContextoReserva => {
    const c: ContextoReserva = { userId: "tenant", nfeId: id, key: { cfc: "empresa", ambiente: "PRODUCAO", modelo: "55", serie: 1 },
      isDefault: false, row: { numero: -1, serie: 1, ambiente: "PRODUCAO", companyFiscalConfigId: "empresa", status: "DRAFT" },
      providerName: "SEFAZ_DIRECT", emitenteSnapshot: {} };
    repo.state.notas.set(id, { id, userId: c.userId, numero: c.row.numero, status: "VALIDATING", key: c.key });
    return c;
  };
  const start = (r: Reserva) => svc.iniciarTransmissao(r, { provedor: "SEFAZ_DIRECT", chaveAcesso: "1".repeat(44), dhEmi: clock,
    digestValue: "digest", xmlAssinadoPath: "/tmp/assinado.xml", conteudoSha256: "a".repeat(64), focusRef: null }, 600_000);
  return { repo, svc, ctx, start };
}

describe("autorização limpa o cStat da rejeição anterior", () => {
  it("rejeitada (232) e depois AUTORIZADA na MESMA reserva termina sem cStatRejeicao", async () => {
    const w = mundo(); const c = w.ctx("dls-710");
    const reserva = await w.svc.reservarOuReutilizar(c);
    const primeira = await w.start(reserva);
    await w.svc.registrarResposta(primeira.reserva, primeira.tentativa, { classificacao: classificarCStatSefaz(232) });
    expect(w.repo.state.notas.get("dls-710")).toMatchObject({ status: "REJECTED", cStatRejeicao: 232 });

    // Reemissão: o claim devolve a nota para VALIDATING limpando SÓ o motivo — é
    // daqui que o 232 chega vivo na tentativa autorizada.
    const nota = w.repo.state.notas.get("dls-710")!;
    nota.status = "VALIDATING"; nota.motivoRejeicao = null;
    c.row.numero = reserva.numero; c.row.status = "REJECTED"; c.row.cStatRejeicao = 232;
    const reusada = await w.svc.reservarOuReutilizar(c);
    expect(reusada).toMatchObject({ id: reserva.id, numero: reserva.numero, origemDecisao: "REUSO" });
    const segunda = await w.start(reusada);
    expect(w.repo.state.notas.get("dls-710")).toMatchObject({ status: "SENDING", cStatRejeicao: 232 });

    const autorizada = await w.svc.registrarResposta(segunda.reserva, segunda.tentativa,
      { classificacao: classificarCStatSefaz(100, { nProt: PROTOCOLO }), protocolo: PROTOCOLO, chaveAcesso: "1".repeat(44) });
    expect(autorizada).toMatchObject({ estado: "AUTORIZADO", numero: reserva.numero });
    const final = w.repo.state.notas.get("dls-710")!;
    expect(final).toMatchObject({ status: "AUTHORIZED", protocoloAutorizacao: PROTOCOLO, chaveAcesso: "1".repeat(44) });
    expect(final.cStatRejeicao).toBeNull();
    expect(final.motivoRejeicao).toBeNull();
  });

  // O readback da Focus é o OUTRO ponto que grava AUTHORIZED sem passar por
  // `aplicarResultado` (numeração divergente: a Focus autorizou com número diferente
  // do reservado). Hoje é inalcançável em produção — NFE_NUMERACAO_V2_FOCUS_ENABLED
  // está desligada —, mas a Focus é o provedor da maioria dos clientes.
  it("readback da Focus com número divergente também não deixa cStat para trás", async () => {
    const w = mundo(); const c = w.ctx("focus-divergente");
    c.providerName = "FOCUS_NFE";
    const reserva = await w.svc.reservarOuReutilizar(c);
    const envio = await w.svc.iniciarTransmissao(reserva, { provedor: "FOCUS_NFE", chaveAcesso: null, dhEmi: new Date(),
      digestValue: null, xmlAssinadoPath: null, conteudoSha256: "a".repeat(64), focusRef: "ref-1" }, 600_000);
    // Rejeição anterior sobrevivendo na linha, como no caso da 710.
    w.repo.state.notas.get("focus-divergente")!.cStatRejeicao = 232;

    await w.svc.registrarReadbackFocus(envio.reserva, envio.tentativa,
      { classificacao: classificarCStatSefaz(100, { nProt: PROTOCOLO }), protocolo: PROTOCOLO, chaveAcesso: "1".repeat(44) },
      { numero: 9, serie: 1 }, false);

    const final = w.repo.state.notas.get("focus-divergente")!;
    expect(final).toMatchObject({ status: "AUTHORIZED", numero: 9 });
    expect(final.cStatRejeicao).toBeNull();
  });

  // O fake grava o patch inteiro; só o repositório real passa pela allowlist NOTA_COLUNAS.
  // Sem esta guarda, tirar a coluna da allowlist faria o patch acima virar no-op em silêncio.
  it("o UPDATE real da nota admite cStatRejeicao na allowlist", async () => {
    const chamadas: Array<{ sql: string; valores: unknown[] }> = [];
    const db = { $queryRawUnsafe: async (sql: string, ...valores: unknown[]) => { chamadas.push({ sql, valores }); return [{ id: "dls-710" }]; },
      $executeRawUnsafe: async () => 0 } as unknown as PrismaClient;
    await new NfeNumeracaoRepository(db).atualizarNota("tenant", "dls-710", ["SENDING"],
      { status: "AUTHORIZED", chaveAcesso: "1".repeat(44), cStatRejeicao: null, protocoloAutorizacao: PROTOCOLO });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].sql).toContain('"cStatRejeicao"=$');
    expect(chamadas[0].valores).toContain(null);
  });
});
