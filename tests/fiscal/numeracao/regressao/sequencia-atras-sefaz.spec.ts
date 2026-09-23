import { describe, expect, it } from "vitest";
import { classificarCStatSefaz } from "../../../../app/fiscal/numeracao/classificacao";
import { NumeracaoError } from "../../../../app/fiscal/numeracao/numeracao.errors";
import { NfeNumeracaoService } from "../../../../app/fiscal/numeracao/numeracao.service";
import type { ContextoReserva } from "../../../../app/fiscal/numeracao/persistencia";
import type { Classificacao } from "../../../../app/fiscal/numeracao/tipos";
import { FakeNumeracaoRepository } from "../../__harness__/fake-numeracao-repository";

// REGRESSÃO (revisão adversarial da V2, bloqueante 2): o guard
// SEQUENCIA_ATRAS_DA_SEFAZ lança ANTES de qualquer `inserirReserva`, então
// nenhuma 4ª reserva entra na chave, as 3 CONSUMIDO_EXTERNO seguem sendo as
// mais recentes (`reservasNaChave` ordena por createdAt DESC) e o 409 valia
// para TODA nota daquele (emitente, ambiente, modelo, série) — de qualquer
// operador, para sempre. Pior: a mensagem mandava "ajuste o próximo número",
// mas o ajuste escreve em NfeSequence e o guard lia NfeNumeroReserva; e
// excluir o rascunho também não solta (viva() não inclui CONSUMIDO_EXTERNO e
// NfeNumeroReserva não tem FK para NfeEmitida — "a reserva sobrevive à
// exclusão do rascunho", schema.prisma).
//
// A saída é a que a própria mensagem promete: o guard só vale enquanto o
// contador ainda aponta para dentro da faixa já provada consumida na SEFAZ.

/** 539 na consulta, reconciliado como o orquestrador faz no caminho real. */
function consumidoExterno(numero: number): Classificacao {
  return { ...classificarCStatSefaz(539), estadoAlvo: "CONSUMIDO_EXTERNO", conclusiva: true,
    mensagem: `Nº ${numero} já usado na SEFAZ pela chave de outro documento` };
}

function mundo() {
  const repo = new FakeNumeracaoRepository();
  const svc = new NfeNumeracaoService(repo, () => new Date("2026-09-23T12:00:00Z"), () => "12345678");
  const key = { cfc: "vip-auto-parts", ambiente: "PRODUCAO", modelo: "55", serie: 1 };
  const ctx = (id: string): ContextoReserva => {
    const c: ContextoReserva = { userId: "tenant", nfeId: id, key: { ...key }, isDefault: false,
      row: { numero: -1, serie: 1, ambiente: "PRODUCAO", companyFiscalConfigId: "vip-auto-parts", status: "DRAFT" },
      providerName: "SEFAZ_DIRECT", emitenteSnapshot: {} };
    repo.state.notas.set(id, { id, userId: c.userId, numero: c.row.numero, status: "VALIDATING", key: c.key });
    return c;
  };
  /** Reserva → transmite → a consulta devolve 539: o número morre CONSUMIDO_EXTERNO. */
  const queimarNaSefaz = async (id: string): Promise<number> => {
    const r = await svc.reservarOuReutilizar(ctx(id));
    const { reserva, tentativa } = await svc.iniciarTransmissao(r, { provedor: "SEFAZ_DIRECT",
      chaveAcesso: "1".repeat(44), dhEmi: new Date(), digestValue: "digest", xmlAssinadoPath: "/tmp/a.xml",
      conteudoSha256: "a".repeat(64), focusRef: null }, 600_000);
    const fim = await svc.registrarConsulta(reserva, tentativa, { classificacao: consumidoExterno(r.numero) });
    expect(fim.estado).toBe("CONSUMIDO_EXTERNO");
    return r.numero;
  };
  const contador = () => [...repo.state.sequences.values()][0].proximoNumero;
  return { repo, svc, key, ctx, queimarNaSefaz, contador };
}

describe("SEQUENCIA_ATRAS_DA_SEFAZ tem saída pelo contador", () => {
  it("(a) 3 CONSUMIDO_EXTERNO seguidos ainda barram a 4ª tentativa", async () => {
    const w = mundo();
    for (const id of ["n1", "n2", "n3"]) await w.queimarNaSefaz(id);

    await expect(w.svc.reservarOuReutilizar(w.ctx("n4"))).rejects.toMatchObject({
      code: "SEQUENCIA_ATRAS_DA_SEFAZ", httpStatus: 409,
    });
    // Barrou de verdade: nenhuma 4ª reserva entrou na chave.
    expect((await w.repo.reservasNaChave("tenant", w.key)).length).toBe(3);
  });

  it("(b) depois de avançar o contador, a MESMA chave fiscal volta a reservar", async () => {
    const w = mundo();
    const queimados: number[] = [];
    for (const id of ["n1", "n2", "n3"]) queimados.push(await w.queimarNaSefaz(id));
    await expect(w.svc.reservarOuReutilizar(w.ctx("n4"))).rejects.toMatchObject({ code: "SEQUENCIA_ATRAS_DA_SEFAZ" });

    // A remediação que a mensagem manda fazer: pôr o contador à frente da
    // faixa que a SEFAZ já tem. (Ajustar para o próprio contador atual é
    // no-op e continua barrado — coberto pelo caso (c).)
    const alvo = Math.max(...queimados) + 20;
    await w.svc.avancarContadorAtomico("tenant", w.key, false, alvo);

    const liberada = await w.svc.reservarOuReutilizar(w.ctx("n4"));
    expect(liberada).toMatchObject({ numero: alvo, origemDecisao: "CONTADOR" });
    // E a chave volta a funcionar para a nota seguinte, não só para uma.
    expect((await w.svc.reservarOuReutilizar(w.ctx("n5"))).numero).toBe(alvo + 1);
  });

  it("(c) avançar o contador não destrava quando as 3 reservas são POSTERIORES ao ajuste", async () => {
    const w = mundo();
    await w.svc.reservarOuReutilizar(w.ctx("semente")); // cria a sequência
    await w.svc.avancarContadorAtomico("tenant", w.key, false, 50);
    for (const id of ["n1", "n2", "n3"]) await w.queimarNaSefaz(id);

    await expect(w.svc.reservarOuReutilizar(w.ctx("n4"))).rejects.toMatchObject({
      code: "SEQUENCIA_ATRAS_DA_SEFAZ", httpStatus: 409,
    });
    // Repetir o MESMO ajuste (no-op sob GREATEST) também não pode destravar.
    await w.svc.avancarContadorAtomico("tenant", w.key, false, 50);
    await expect(w.svc.reservarOuReutilizar(w.ctx("n4"))).rejects.toMatchObject({ code: "SEQUENCIA_ATRAS_DA_SEFAZ" });
  });

  it("a mensagem diz o número mínimo que destrava, e não manda fazer coisa inócua", async () => {
    const w = mundo();
    const queimados: number[] = [];
    for (const id of ["n1", "n2", "n3"]) queimados.push(await w.queimarNaSefaz(id));
    const minimo = Math.max(...queimados) + 2;

    const erro = await w.svc.reservarOuReutilizar(w.ctx("n4")).then(
      () => null,
      (e: unknown) => e as NumeracaoError,
    );
    expect(erro).toBeInstanceOf(NumeracaoError);
    // O piso citado no texto é exatamente o que o guard aceita.
    expect(erro!.message).toContain(String(minimo));
    expect(erro!.detalhes?.proximoNumeroMinimo).toBe(minimo);
    expect(erro!.detalhes?.numeros).toEqual([...queimados].sort((a, b) => a - b));
    await w.svc.avancarContadorAtomico("tenant", w.key, false, minimo);
    expect((await w.svc.reservarOuReutilizar(w.ctx("n4"))).numero).toBe(minimo);
  });
});
