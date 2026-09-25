// B6 (prontidão V2): o 409 SEQUENCIA_ATRAS_DA_SEFAZ passa a dizer ONDE ajustar o contador.
// Contrato C3: `code` e `httpStatus` não mudam, e as chaves de `detalhes` continuam as mesmas
// (a tela reage ao code; o texto é para quem lê o toast/log).

import { describe, expect, it } from "vitest";
import { NfeNumeracaoService } from "../../../app/fiscal/numeracao/numeracao.service";
import { NumeracaoError } from "../../../app/fiscal/numeracao/numeracao.errors";
import { classificarCStatSefaz } from "../../../app/fiscal/numeracao/classificacao";
import type { ContextoReserva } from "../../../app/fiscal/numeracao/persistencia";
import type { Classificacao } from "../../../app/fiscal/numeracao/tipos";
import { FakeNumeracaoRepository } from "../__harness__/fake-numeracao-repository";

/** 539 na consulta, reconciliado como o orquestrador faz (mesmo construtor de sequencia-atras-sefaz.spec). */
const consumidoExterno = (numero: number): Classificacao => ({
  ...classificarCStatSefaz(539), estadoAlvo: "CONSUMIDO_EXTERNO", conclusiva: true,
  mensagem: `Nº ${numero} já usado na SEFAZ pela chave de outro documento`,
});

describe("SEQUENCIA_ATRAS_DA_SEFAZ indica o caminho do ajuste na tela", () => {
  it("texto cita Configuração fiscal → empresa → Ambiente & Provedor → Ajustar próximo número; code/status/detalhes intactos", async () => {
    const repo = new FakeNumeracaoRepository();
    const svc = new NfeNumeracaoService(repo, () => new Date("2026-09-25T12:00:00Z"), () => "12345678");
    const key = { cfc: "empresa", ambiente: "PRODUCAO", modelo: "55", serie: 1 };
    const ctx = (id: string): ContextoReserva => {
      repo.state.notas.set(id, { id, userId: "tenant", numero: -1, status: "VALIDATING", key });
      return { userId: "tenant", nfeId: id, key, isDefault: false, providerName: "SEFAZ_DIRECT", emitenteSnapshot: {},
        row: { numero: -1, serie: 1, ambiente: "PRODUCAO", companyFiscalConfigId: "empresa", status: "DRAFT" } };
    };
    for (const id of ["n1", "n2", "n3"]) {
      const r = await svc.reservarOuReutilizar(ctx(id));
      const { reserva, tentativa } = await svc.iniciarTransmissao(r, { provedor: "SEFAZ_DIRECT", chaveAcesso: "1".repeat(44), dhEmi: new Date(),
        digestValue: "digest", xmlAssinadoPath: "/tmp/a.xml", conteudoSha256: "a".repeat(64), focusRef: null }, 600_000);
      await svc.registrarConsulta(reserva, tentativa, { classificacao: consumidoExterno(r.numero) });
    }
    const erro = await svc.reservarOuReutilizar(ctx("n4")).then(() => null, (e: unknown) => e as NumeracaoError);
    expect(erro).toBeInstanceOf(NumeracaoError);
    expect(erro).toMatchObject({ code: "SEQUENCIA_ATRAS_DA_SEFAZ", httpStatus: 409 });
    expect(erro!.message).toContain("Configuração fiscal → empresa → Ambiente & Provedor → Ajustar próximo número");
    expect(Object.keys(erro!.detalhes ?? {}).sort()).toEqual(["ambiente", "modelo", "numeros", "proximoNumeroAtual", "proximoNumeroMinimo", "serie"]);
  });
});
