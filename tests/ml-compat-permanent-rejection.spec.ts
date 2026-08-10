/**
 * Recusa PERMANENTE de compatibilidade (10/08/2026).
 *
 * Produção acumulou 52.130 linhas `[ML Compat]` do MESMO produto em ciclo, com
 * 4.062 `Maximum quota has been exceeded` de brinde — e a cota do ML é
 * compartilhada com anúncio, estoque e pedidos.
 *
 * Causa: a escada só olhava o STATUS HTTP, então um 400 SEMÂNTICO permanente
 * ("este domínio não aceita compatibilidade") era indistinguível de um 400 de
 * corpo mal formado. Cada produto gastava 4 chamadas no lote + 4 por ID no
 * fallback individual — ~204 chamadas garantidas de falhar, por invocação.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MLApiService,
  extractUnsupportedDomain,
  isPermanentCompatRejection,
} from "../app/marketplaces/services/ml-api.service";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

const DOMINIO_SEM_COMPAT =
  "The user product domain MLB-VEHICLE_TRAILER_LIGHT_POWER_MODULES does not have active compatibilities.";
const SEM_COMPAT_ENTRE_DOMINIOS =
  "There is no compatibility between MLB-CARS_AND_VANS and MLB-VEHICLE_TRAILER_LIGHT_POWER_MODULES and the category MLB433203";

describe("isPermanentCompatRejection", () => {
  it("reconhece as DUAS recusas permanentes vistas em produção", () => {
    expect(isPermanentCompatRejection(DOMINIO_SEM_COMPAT)).toBe(true);
    expect(isPermanentCompatRejection(SEM_COMPAT_ENTRE_DOMINIOS)).toBe(true);
  });

  it("reconhece a mensagem embrulhada no JSON de erro do axios", () => {
    expect(
      isPermanentCompatRejection(`400 ${JSON.stringify({ message: DOMINIO_SEM_COMPAT })}`),
    ).toBe(true);
    expect(
      isPermanentCompatRejection(
        `400 ${JSON.stringify({ message: SEM_COMPAT_ENTRE_DOMINIOS })}`,
      ),
    ).toBe(true);
  });

  it("NÃO trata erro de corpo mal formado como permanente (senão perde retentativa legítima)", () => {
    expect(isPermanentCompatRejection("Invalid request body")).toBe(false);
    expect(
      isPermanentCompatRejection(
        "Invalid arguments for specific request. Please check details to satisfy validations",
      ),
    ).toBe(false);
    expect(
      isPermanentCompatRejection("create.products_families[0].attributes: must not be empty"),
    ).toBe(false);
  });

  it("⚠️ NÃO trata limite de cota/rate-limit como permanente — são TRANSITÓRIOS", () => {
    // Estes vêm em 4xx e apareceram 4.062+362 vezes no log. Marcá-los como
    // permanentes descartaria compatibilidade legítima em pico de uso.
    expect(isPermanentCompatRejection("Maximum quota has been exceeded")).toBe(false);
    expect(isPermanentCompatRejection("local_rate_limited")).toBe(false);
  });

  it("string vazia/lixo não explode", () => {
    expect(isPermanentCompatRejection("")).toBe(false);
    expect(isPermanentCompatRejection(undefined as unknown as string)).toBe(false);
  });

  it("extractUnsupportedDomain segue devolvendo o domínio (contrato antigo intacto)", () => {
    expect(extractUnsupportedDomain(DOMINIO_SEM_COMPAT)).toBe(
      "MLB-VEHICLE_TRAILER_LIGHT_POWER_MODULES",
    );
    expect(extractUnsupportedDomain("Invalid request body")).toBeNull();
    // A 2ª mensagem NÃO nomeia um "user product domain" — só o predicado novo
    // a cobre. Manter isto documenta por que os dois existem.
    expect(extractUnsupportedDomain(SEM_COMPAT_ENTRE_DOMINIOS)).toBeNull();
  });
});

describe("setItemCompatibilities — recusa permanente não faz fan-out", () => {
  beforeEach(() => {
    (mockedAxios as any).post = vi.fn();
    (mockedAxios as any).get = vi.fn().mockRejectedValue(new Error("sem leitura"));
    (mockedAxios as any).isAxiosError = () => false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("para na PRIMEIRA chamada quando o lote é recusado permanentemente", async () => {
    (mockedAxios as any).post.mockRejectedValue(new Error(SEM_COMPAT_ENTRE_DOMINIOS));

    const result = await MLApiService.setItemCompatibilities("tok", "MLB1", [
      "MLB1000",
      "MLB1001",
      "MLB1002",
    ]);

    // ANTES: 1 (lote) + 3 (individuais) = 4. AGORA: só o lote.
    expect((mockedAxios as any).post).toHaveBeenCalledTimes(1);
    expect(result.createdCount).toBe(0);
    expect(result.success).toBe(false);
    // O erro do lote era DESCARTADO; agora chega em `errors` para que
    // `dominioRecusado()` consiga enxergar a causa e pular os degraus 2 e 3.
    expect(result.errors).toHaveLength(1);
    expect(isPermanentCompatRejection(result.errors[0])).toBe(true);
  });

  it("o erro que sobrevive é o ACIONÁVEL — `dominioRecusado()` volta a enxergá-lo", async () => {
    // Este é o elo que estava quebrado: a variante 1 do corpo devolvia a
    // mensagem de domínio, a 2 e a 3 SOBRESCREVIAM `lastErr`, e o que chegava
    // em `errors` era "Invalid request body" — que `extractUnsupportedDomain`
    // não casa. Resultado: o guard de domínio (ml-api.service.ts:3021) nunca
    // disparava e a escada seguia para os degraus 2 e 3.
    (mockedAxios as any).post.mockRejectedValue(new Error(DOMINIO_SEM_COMPAT));

    const result = await MLApiService.setItemCompatibilities("tok", "MLB1", [
      "MLB1000",
      "MLB1001",
    ]);

    expect(result.errors).toHaveLength(1);
    // `applyCompatibilitiesVerified` faz `errors.push(...r.errors)` e só então
    // roda `extractUnsupportedDomain` sobre cada um.
    expect(extractUnsupportedDomain(result.errors[0])).toBe(
      "MLB-VEHICLE_TRAILER_LIGHT_POWER_MODULES",
    );
  });

  it("REGRESSÃO: falha genérica continua isolando ID por ID", async () => {
    (mockedAxios as any).post
      .mockRejectedValueOnce(new Error("batch 400 one invalid id"))
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new Error("400 invalid catalog id"));

    const result = await MLApiService.setItemCompatibilities("tok", "MLB1", [
      "MLB_OK",
      "MLB_BAD",
    ]);

    // Comportamento histórico intocado: 1 lote + 2 individuais.
    expect((mockedAxios as any).post).toHaveBeenCalledTimes(3);
    expect(result.createdCount).toBe(1);
    expect(result.errors[0]).toContain("MLB_BAD");
  });

  it("recusa permanente que só aparece no individual interrompe o resto do loop", async () => {
    (mockedAxios as any).post
      .mockRejectedValueOnce(new Error("batch 400 generico")) // lote: transitório
      .mockResolvedValueOnce({ data: {} }) // id 1 OK
      .mockRejectedValueOnce(new Error(DOMINIO_SEM_COMPAT)) // id 2: permanente
      .mockResolvedValue({ data: {} }); // id 3 nunca deveria ser chamado

    const result = await MLApiService.setItemCompatibilities("tok", "MLB1", [
      "MLB_A",
      "MLB_B",
      "MLB_C",
    ]);

    // 1 lote + 2 individuais (para no B). Sem o break seriam 4.
    expect((mockedAxios as any).post).toHaveBeenCalledTimes(3);
    expect(result.createdCount).toBe(1);
    expect(result.errors.some((e: string) => isPermanentCompatRejection(e))).toBe(true);
  });
});
