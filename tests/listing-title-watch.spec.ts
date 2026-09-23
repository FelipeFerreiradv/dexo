import { describe, expect, it, vi } from "vitest";

import prisma from "../app/lib/prisma";

import { ListingTitleWatchService } from "../app/marketplaces/services/listing-title-watch.service";

/**
 * O que importa testar aqui e o FATIAMENTO, porque foi ele que curou a doenca
 * da vigilia anterior: o cursor em memoria do sweep de status zera a cada
 * restart e nunca fecha uma volta. A fatia vem do relogio, entao ela e
 * deterministica, sobrevive a restart e cobre a base inteira por construcao.
 */
describe("fatiamento pelo relogio", () => {
  it("duas passadas na mesma hora visitam a MESMA fatia", () => {
    const umaHora = new Date("2026-09-23T14:05:00.000Z");
    const mesmaHora = new Date("2026-09-23T14:57:00.000Z");
    expect(ListingTitleWatchService.sliceForClock(umaHora)).toBe(
      ListingTitleWatchService.sliceForClock(mesmaHora),
    );
  });

  it("horas seguidas visitam fatias diferentes", () => {
    const h14 = ListingTitleWatchService.sliceForClock(new Date("2026-09-23T14:00:00.000Z"));
    const h15 = ListingTitleWatchService.sliceForClock(new Date("2026-09-23T15:00:00.000Z"));
    expect(h14).not.toBe(h15);
  });

  it("cobre TODAS as fatias em 24 horas, sem repetir", () => {
    // Esta e a garantia que a vigilia de disponibilidade nao tinha: la o
    // deslocamento nunca passou de 4.000 de 10.698 e 62,6% da base jamais foi
    // verificada.
    const inicio = Date.parse("2026-09-23T00:00:00.000Z");
    const vistas = new Set<number>();
    for (let h = 0; h < 24; h += 1) {
      vistas.add(ListingTitleWatchService.sliceForClock(new Date(inicio + h * 60 * 60 * 1000)));
    }
    expect(vistas.size).toBe(24);
  });

  it("nunca devolve fatia negativa, nem antes da epoch", () => {
    // `%` em JavaScript devolve negativo para operando negativo; sem a
    // normalizacao a consulta compararia com fatia que nao existe e a passada
    // voltaria VAZIA — falha silenciosa, o pior tipo aqui.
    const antesDaEpoch = new Date(-5 * 60 * 60 * 1000);
    const fatia = ListingTitleWatchService.sliceForClock(antesDaEpoch);
    expect(fatia).toBeGreaterThanOrEqual(0);
    expect(fatia).toBeLessThan(24);
  });

  it("respeita o numero de fatias informado", () => {
    const agora = new Date("2026-09-23T14:00:00.000Z");
    expect(ListingTitleWatchService.sliceForClock(agora, 6)).toBeLessThan(6);
    expect(ListingTitleWatchService.sliceForClock(agora, 1)).toBe(0);
  });
});

describe("porta de entrada da vigilia", () => {
  it("nao TOCA no banco sem a flag ligada", async () => {
    // Sem esta porta a rotina consultaria producao no primeiro tick de
    // qualquer ambiente que apenas IMPORTE o servico. Observar o retorno nao
    // basta: com a porta removida a consulta falha e o catch devolve undefined
    // do mesmo jeito. Quem denuncia e a consulta ter acontecido.
    const anterior = process.env.LISTING_TITLE_WATCH_ENABLED;
    delete process.env.LISTING_TITLE_WATCH_ENABLED;
    const consultou = vi.spyOn(prisma, "$queryRaw");
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await ListingTitleWatchService.watchTitlesOnce(new Date("2026-09-23T14:00:00.000Z"));
      expect(consultou).not.toHaveBeenCalled();
      expect(erro).not.toHaveBeenCalled();
      expect(aviso).not.toHaveBeenCalled();
    } finally {
      consultou.mockRestore();
      erro.mockRestore();
      aviso.mockRestore();
      if (anterior === undefined) delete process.env.LISTING_TITLE_WATCH_ENABLED;
      else process.env.LISTING_TITLE_WATCH_ENABLED = anterior;
    }
  });

  it("start() nao arma temporizador com a flag desligada", () => {
    const anterior = process.env.LISTING_TITLE_WATCH_ENABLED;
    delete process.env.LISTING_TITLE_WATCH_ENABLED;
    try {
      ListingTitleWatchService.start();
      // Se tivesse armado, o processo do teste nao encerraria sozinho.
      expect((ListingTitleWatchService as unknown as { intervalId: unknown }).intervalId).toBeNull();
    } finally {
      ListingTitleWatchService.stop();
      if (anterior === undefined) delete process.env.LISTING_TITLE_WATCH_ENABLED;
      else process.env.LISTING_TITLE_WATCH_ENABLED = anterior;
    }
  });
});
