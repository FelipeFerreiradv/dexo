import { beforeEach, describe, expect, it, vi } from "vitest";

// REGRESSÃO (continuação de sequencia-atras-sefaz.spec.ts): o guard das 3
// CONSUMIDO_EXTERNO tranca a série com 409 SEQUENCIA_ATRAS_DA_SEFAZ e a
// mensagem manda "ponha o próximo número da série em N ou mais". Aquele spec
// prova que a saída EXISTE no serviço (`avancarContadorAtomico`); este prova
// que a saída chega ao PRODUTO: o caso de uso do ajuste manual, com o escopo
// (emitente, ambiente, modelo, série) vindo da requisição, move o MESMO
// contador que o guard lê — e a série volta a emitir.
//
// Por que isso não é óbvio: o ajuste escreve por `NfeSequenceService`
// (Prisma, tabela NfeSequence) e o guard lê por `lockSequencia` (SQL cru na
// MESMA tabela). Se as duas pontas divergissem no filtro por emitente, o
// ajuste "daria certo" e a série continuaria trancada — que é exatamente a
// armadilha descrita no cabeçalho do spec irmão ("o ajuste escreve em
// NfeSequence e o guard lia NfeNumeroReserva").
//
// A ponte deste teste: o prisma em memória abaixo lê e escreve o MESMO
// `state.sequences` do FakeNumeracaoRepository, com a mesma chave que ele usa
// (`${userId}:${chaveOrdenavel(key)}`). Ou seja, os dois lados disputam a mesma
// linha, como em produção — e um erro de escopo no caso de uso falha aqui.

const h = vi.hoisted(() => {
  const ref: { sequences: Map<string, any> | null } = { sequences: null };
  const logs: Array<Record<string, any>> = [];
  const configs: Array<Record<string, unknown>> = [];

  // Espelho de `chaveOrdenavel` + `key` do FakeNumeracaoRepository.
  const idDe = (
    userId: string,
    cfc: string | null,
    ambiente: string,
    modelo: string,
    serie: number,
  ) => `${userId}:${JSON.stringify([cfc, ambiente, modelo, serie])}`;

  const prisma = {
    companyFiscalConfig: {
      findFirst: async ({ where }: any) =>
        configs.find((c) =>
          Object.entries(where).every(([k, v]) => (c as any)[k] === v),
        ) ?? null,
    },
    nfeSequence: {
      findFirst: async ({ where }: any) => {
        const cfc = (where.OR ?? [])[0]?.companyFiscalConfigId ?? null;
        const id = idDe(where.userId, cfc, where.ambiente, where.modelo, where.serie);
        const row = ref.sequences?.get(id);
        return row ? { ...row } : null;
      },
      update: async ({ where, data }: any) => {
        const row = ref.sequences?.get(where.id);
        if (!row) throw new Error("NfeSequence não encontrada");
        const novo = { ...row, ...data };
        ref.sequences!.set(where.id, novo);
        return novo;
      },
      create: async ({ data }: any) => {
        const id = idDe(
          data.userId,
          data.companyFiscalConfigId ?? null,
          data.ambiente,
          data.modelo,
          data.serie,
        );
        const row = { id, ...data };
        ref.sequences!.set(id, row);
        return row;
      },
    },
    systemLog: {
      create: async ({ data }: any) => {
        logs.push(data);
        return { id: `log-${logs.length}`, ...data };
      },
    },
  };
  return { ref, logs, configs, prisma };
});

vi.mock("../../../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));

import { classificarCStatSefaz } from "../../../../app/fiscal/numeracao/classificacao";
import { NumeracaoError } from "../../../../app/fiscal/numeracao/numeracao.errors";
import { NfeNumeracaoService } from "../../../../app/fiscal/numeracao/numeracao.service";
import type { ContextoReserva } from "../../../../app/fiscal/numeracao/persistencia";
import type { Classificacao } from "../../../../app/fiscal/numeracao/tipos";
import {
  NfeSequenceAjusteUseCase,
  type AjusteProximoNumeroInput,
} from "../../../../app/usecases/nfe-sequence-ajuste.usecase";
import { FakeNumeracaoRepository } from "../../__harness__/fake-numeracao-repository";

const CFC = "vip-auto-parts";
const TENANT = "tenant";
const MOTIVO = "cliente informou que o ultimo numero emitido no sistema anterior foi 7420";

/** 539 na consulta, reconciliado como o orquestrador faz no caminho real. */
function consumidoExterno(numero: number): Classificacao {
  return {
    ...classificarCStatSefaz(539),
    estadoAlvo: "CONSUMIDO_EXTERNO",
    conclusiva: true,
    mensagem: `Nº ${numero} já usado na SEFAZ pela chave de outro documento`,
  };
}

function mundo() {
  const repo = new FakeNumeracaoRepository();
  // A ponte: o prisma em memória passa a operar sobre as MESMAS sequências.
  h.ref.sequences = repo.state.sequences as unknown as Map<string, any>;
  const svc = new NfeNumeracaoService(repo, () => new Date("2026-09-23T12:00:00Z"), () => "12345678");
  const key = { cfc: CFC, ambiente: "PRODUCAO", modelo: "55", serie: 1 };
  const ctx = (id: string): ContextoReserva => {
    const c: ContextoReserva = {
      userId: TENANT, nfeId: id, key: { ...key }, isDefault: false,
      row: { numero: -1, serie: 1, ambiente: "PRODUCAO", companyFiscalConfigId: CFC, status: "DRAFT" },
      providerName: "SEFAZ_DIRECT", emitenteSnapshot: {},
    };
    repo.state.notas.set(id, { id, userId: c.userId, numero: c.row.numero, status: "VALIDATING", key: c.key });
    return c;
  };
  const queimarNaSefaz = async (id: string): Promise<number> => {
    const r = await svc.reservarOuReutilizar(ctx(id));
    const { reserva, tentativa } = await svc.iniciarTransmissao(r, {
      provedor: "SEFAZ_DIRECT", chaveAcesso: "1".repeat(44), dhEmi: new Date(),
      digestValue: "digest", xmlAssinadoPath: "/tmp/a.xml", conteudoSha256: "a".repeat(64), focusRef: null,
    }, 600_000);
    const fim = await svc.registrarConsulta(reserva, tentativa, { classificacao: consumidoExterno(r.numero) });
    expect(fim.estado).toBe("CONSUMIDO_EXTERNO");
    return r.numero;
  };
  return { repo, svc, key, ctx, queimarNaSefaz };
}

const ajuste = (
  proximoNumero: number,
  over: Partial<AjusteProximoNumeroInput> = {},
): AjusteProximoNumeroInput => ({
  companyFiscalConfigId: CFC,
  ambiente: "PRODUCAO",
  modelo: "55",
  serie: 1,
  proximoNumero,
  motivo: MOTIVO,
  confirmar: true,
  ...over,
});

beforeEach(() => {
  h.logs.length = 0;
  h.configs.length = 0;
  h.configs.push({
    id: CFC, userId: TENANT, cnpj: "11222333000181", razaoSocial: "VIP Auto Parts LTDA",
    ambiente: "PRODUCAO", regimeTributario: "SIMPLES", isDefault: false, serieNfe: 1,
  });
});

describe("o ajuste manual destrava SEQUENCIA_ATRAS_DA_SEFAZ", () => {
  it("(f) com a V2 ligada, depois do ajuste a mesma chave volta a reservar", async () => {
    const w = mundo();
    const queimados: number[] = [];
    for (const id of ["n1", "n2", "n3"]) queimados.push(await w.queimarNaSefaz(id));

    const barrado = await w.svc.reservarOuReutilizar(w.ctx("n4")).then(
      () => null,
      (e: unknown) => e as NumeracaoError,
    );
    expect(barrado).toBeInstanceOf(NumeracaoError);
    expect(barrado!.code).toBe("SEQUENCIA_ATRAS_DA_SEFAZ");
    const minimo = barrado!.detalhes!.proximoNumeroMinimo as number;
    expect(minimo).toBe(Math.max(...queimados) + 2);

    // O operador faz EXATAMENTE o que a mensagem manda, pelo caminho novo do
    // produto (rota → caso de uso), e não por SQL em produção.
    const r = await new NfeSequenceAjusteUseCase().ajustar(
      TENANT,
      ajuste(minimo),
      { atorUserId: "dono-1" },
    );
    expect(r.proximoNumero).toBe(minimo);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0].action).toBe("ADJUST_NFE_SEQUENCE");

    // O guard para de barrar — e a chave segue funcionando para a nota seguinte.
    const liberada = await w.svc.reservarOuReutilizar(w.ctx("n4"));
    expect(liberada).toMatchObject({ numero: minimo, origemDecisao: "CONTADOR" });
    expect((await w.svc.reservarOuReutilizar(w.ctx("n5"))).numero).toBe(minimo + 1);
  });

  it("(f2) ajustar o contador de OUTRA série não destrava a série trancada", async () => {
    const w = mundo();
    const queimados: number[] = [];
    for (const id of ["n1", "n2", "n3"]) queimados.push(await w.queimarNaSefaz(id));
    const minimo = Math.max(...queimados) + 2;

    // Mesmo emitente, mesmo ambiente, mesmo modelo — série 2. Se o caso de uso
    // ignorasse a série, isto "consertaria" a série 1 e o guard cairia.
    await new NfeSequenceAjusteUseCase().ajustar(
      TENANT,
      ajuste(minimo + 1000, { serie: 2 }),
    );

    await expect(w.svc.reservarOuReutilizar(w.ctx("n4"))).rejects.toMatchObject({
      code: "SEQUENCIA_ATRAS_DA_SEFAZ",
    });
  });

  it("(f3) o ajuste recusado por falta de confirmação não destrava nada", async () => {
    const w = mundo();
    const queimados: number[] = [];
    for (const id of ["n1", "n2", "n3"]) queimados.push(await w.queimarNaSefaz(id));
    const minimo = Math.max(...queimados) + 2;

    await expect(
      new NfeSequenceAjusteUseCase().ajustar(
        TENANT,
        ajuste(minimo, { confirmar: false }),
      ),
    ).rejects.toMatchObject({ code: "NUMERACAO_CONFIRMAR_AJUSTE", httpStatus: 409 });

    await expect(w.svc.reservarOuReutilizar(w.ctx("n4"))).rejects.toMatchObject({
      code: "SEQUENCIA_ATRAS_DA_SEFAZ",
    });
    expect(h.logs).toHaveLength(0);
  });
});
