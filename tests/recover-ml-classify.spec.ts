import { describe, it, expect } from "vitest";
import {
  classifyRecoverRow,
  detectRecoverInFlight,
  recoverPreflightBlocks,
  type RecoverInput,
} from "../scripts/lib/recover-ml-classify";

/**
 * Classificação da recuperação de anúncios ML presos. Regra de ouro: nada que
 * possa duplicar anúncio é re-armado, e dado que só a pessoa corrige não é
 * re-armado às cegas.
 */

const base = (over: Partial<RecoverInput> = {}): RecoverInput => ({
  accountActive: true,
  liveLocal: null,
  remote: { status: "ok", adoptable: null, others: [] },
  preflight: { blocked: false, message: null },
  lastError:
    'Erro ao criar item: {"cause":[{"cause_id":369,"code":"body.required_fields"}]}',
  editedAfterError: false,
  ...over,
});

describe("classifyRecoverRow", () => {
  it("369 mascarado, sem bloqueio, nada no ML ⇒ publicavel", () => {
    expect(classifyRecoverRow(base()).classe).toBe("publicavel");
  });

  it("conta inativa vence tudo", () => {
    expect(
      classifyRecoverRow(base({ accountActive: false, liveLocal: { externalListingId: "MLB1", status: "active" } }))
        .classe,
    ).toBe("conta_inativa");
  });

  it("publicação em andamento (pending recente / reservada pelo botão) ⇒ em_andamento, nada é tocado", () => {
    const d = classifyRecoverRow(
      base({ inFlight: "publishing", liveLocal: null, lastError: null }),
    );
    expect(d.classe).toBe("em_andamento");
  });

  it("cron já agendado ⇒ agendado, nada é tocado", () => {
    expect(classifyRecoverRow(base({ inFlight: "scheduled" })).classe).toBe("agendado");
  });

  it("mesmo SKU com outro título criado na janela ⇒ duplicidade_possivel (não adota nem publica)", () => {
    const d = classifyRecoverRow(
      base({
        remote: {
          status: "ok",
          adoptable: null,
          others: [],
          ambiguous: { id: "MLB_X", status: "active", title: "Farol Gol G5" },
        },
      }),
    );
    expect(d.classe).toBe("duplicidade_possivel");
    expect(d.motivo).toMatch(/MLB_X "Farol Gol G5"/);
  });

  it("anúncio vivo local ⇒ ja_publicado (nunca re-arma)", () => {
    const d = classifyRecoverRow(
      base({ liveLocal: { externalListingId: "MLB5188503789", status: "active" } }),
    );
    expect(d.classe).toBe("ja_publicado");
    expect(d.motivo).toContain("MLB5188503789");
  });

  it("item criado no ML depois do pendente ⇒ adotar", () => {
    const d = classifyRecoverRow(
      base({ remote: { status: "ok", adoptable: { id: "MLB9", status: "active" }, others: [] } }),
    );
    expect(d.classe).toBe("adotar");
  });

  it("outro anúncio VIVO com o mesmo SKU ⇒ duplicidade_possivel (não publica)", () => {
    const d = classifyRecoverRow(
      base({
        remote: {
          status: "ok",
          adoptable: null,
          others: [{ id: "MLB7", status: "paused", title: "Farol Gol G5" }],
        },
      }),
    );
    expect(d.classe).toBe("duplicidade_possivel");
    expect(d.motivo).toMatch(/MLB7 \(paused\) "Farol Gol G5"/);
  });

  it("anúncio ENCERRADO com o mesmo SKU não impede", () => {
    expect(
      classifyRecoverRow(
        base({
          remote: { status: "ok", adoptable: null, others: [{ id: "MLB7", status: "closed" }] },
        }),
      ).classe,
    ).toBe("publicavel");
  });

  it.each(["search_failed", "not_checked"] as const)(
    "busca no ML %s ⇒ nao_verificado (sem conferir duplicidade não re-arma)",
    (status) => {
      expect(classifyRecoverRow(base({ remote: { status } })).classe).toBe("nao_verificado");
    },
  );

  it("sem SKU (não dá para buscar) segue a pré-validação", () => {
    expect(classifyRecoverRow(base({ remote: { status: "skipped" } })).classe).toBe(
      "publicavel",
    );
  });

  it("pré-validação bloqueia ⇒ precisa_cliente com a mensagem dela", () => {
    const d = classifyRecoverRow(
      base({ preflight: { blocked: true, message: 'O campo GTIN está com "2033029"' } }),
    );
    expect(d).toEqual({ classe: "precisa_cliente", motivo: 'O campo GTIN está com "2033029"' });
  });

  it.each([
    'O valor que você inseriu em "Número de registro/certificação INMETRO" está incorreto.',
    "A categoria MLB7863 do Mercado Livre exige o campo Número da Peça. Preencha…",
    "[TERMINAL][CORRIGIVEL] As medidas da embalagem parecem erradas (5401)",
    'Erro ao criar item: {"cause":[{"code":"item.pictures.invalid_size"}]}',
  ])("erro que a pré-validação não vê e produto NÃO editado ⇒ precisa_cliente: %s", (lastError) => {
    const d = classifyRecoverRow(base({ lastError }));
    expect(d.classe).toBe("precisa_cliente");
    expect(d.motivo.startsWith("[")).toBe(false);
  });

  it("mesmo erro com o produto alterado depois (venda, sync de preço) ⇒ CONTINUA precisa_cliente; o motivo orienta o botão", () => {
    // `Product.updatedAt` também anda com baixa de estoque e sync de preço:
    // não é prova de que a pessoa corrigiu o INMETRO.
    const d = classifyRecoverRow(
      base({
        lastError: 'O valor que você inseriu em "Número de registro/certificação INMETRO" está incorreto.',
        editedAfterError: true,
      }),
    );
    expect(d.classe).toBe("precisa_cliente");
    expect(d.motivo).toMatch(/INMETRO/);
    expect(d.motivo).toMatch(/Tentar publicar novamente/);
  });

  it("GTIN antigo sem bloqueio atual (corrigido) ⇒ publicavel", () => {
    expect(
      classifyRecoverRow(
        base({ lastError: 'O campo GTIN do produto está em formato inválido ("original").' }),
      ).classe,
    ).toBe("publicavel");
  });
});

describe("detectRecoverInFlight (revisão 23/09, rodada 2)", () => {
  const AGORA = new Date("2026-09-23T12:00:00.000Z").getTime();
  const MIN = 60_000;
  const linha = (over: Record<string, unknown> = {}) => ({
    retryEnabled: false,
    nextRetryAt: null as Date | null,
    updatedAt: new Date(AGORA - 2 * 60 * MIN),
    now: AGORA,
    recenteMs: 30 * MIN,
    ...over,
  });

  it("status 'error' alterado há 2 min (publicação no meio da escada) ⇒ em andamento, não é tocado", () => {
    expect(detectRecoverInFlight(linha({ updatedAt: new Date(AGORA - 2 * MIN) }))).toBe(
      "publishing",
    );
  });

  it("reserva vigente (botão ou a própria criação) ⇒ em andamento", () => {
    expect(
      detectRecoverInFlight(linha({ nextRetryAt: new Date(AGORA + 5 * MIN) })),
    ).toBe("publishing");
  });

  it("retry ligado com horário ⇒ agendado (é do cron)", () => {
    expect(
      detectRecoverInFlight(
        linha({ retryEnabled: true, nextRetryAt: new Date(AGORA - MIN) }),
      ),
    ).toBe("scheduled");
  });

  it("parada há 2 h, sem reserva e sem retry ⇒ livre para a recuperação", () => {
    expect(detectRecoverInFlight(linha())).toBeNull();
    expect(
      detectRecoverInFlight(linha({ nextRetryAt: new Date(AGORA - 60 * MIN) })),
    ).toBeNull();
  });
});

describe("recoverPreflightBlocks — mesmo critério da publicação (revisão 23/09, rodada 2)", () => {
  const valor = {
    attributeId: "GTIN",
    severity: "block",
    message: "O campo GTIN aceita só código de barras.",
  };
  const doAvaliador = {
    attributeId: "SIDE_POSITION",
    reason: "invalid_value",
    message: "Lado com valor de outra categoria.",
  };

  it("sem a flag: só os bloqueios da validação de VALORES contam", () => {
    const r = recoverPreflightBlocks({
      blocking: [doAvaliador, { attributeId: "GTIN", reason: "invalid_value", message: valor.message }],
      valueIssues: [valor, { attributeId: "SIDE_POSITION", severity: "fix", message: "id trocado" }],
      requiredBlockEnabled: false,
    });
    expect(r).toEqual([{ message: valor.message }]);
  });

  it("valor que a publicação CORRIGE sozinha (severidade fix) não bloqueia", () => {
    const r = recoverPreflightBlocks({
      blocking: [doAvaliador],
      valueIssues: [{ attributeId: "SIDE_POSITION", severity: "fix", message: "id trocado" }],
      requiredBlockEnabled: false,
    });
    expect(r).toEqual([]);
  });

  it("com a flag: avaliador de obrigatórios também conta, sem repetir o bloqueio de valor", () => {
    const r = recoverPreflightBlocks({
      blocking: [
        { attributeId: "PART_NUMBER", reason: "missing", message: "Falta o Part Number." },
        { attributeId: "GTIN", reason: "invalid_value", message: valor.message },
      ],
      valueIssues: [valor],
      requiredBlockEnabled: true,
    });
    expect(r).toEqual([{ message: "Falta o Part Number." }, { message: valor.message }]);
  });
});
