import { describe, it, expect, vi } from "vitest";
import {
  findCorrectMLAccount,
  type AccountForRepair,
  type MLItemSnapshot,
} from "./listing-ownership-repair.service";

const acc = (id: string, externalUserId: string, token = "tok-" + id): AccountForRepair => ({
  id,
  externalUserId,
  accessToken: token,
});

describe("findCorrectMLAccount", () => {
  it("retorna repaired=false quando o usuário só tem uma conta (a atual)", async () => {
    const result = await findCorrectMLAccount({
      userId: "u1",
      currentAccountId: "acc-1",
      externalListingId: "MLB123",
      deps: {
        findAccounts: async () => [acc("acc-1", "1111")],
        getItemDetails: async () => ({ seller_id: 1111 }) as MLItemSnapshot,
      },
    });
    expect(result.repaired).toBe(false);
    expect(result.reason).toMatch(/Nenhuma outra conta/);
  });

  it("encontra a conta correta quando o item pertence a outra conta do usuário", async () => {
    const getItemDetails = vi.fn(async (token: string, _id: string) => {
      // Conta acc-2 (token=tok-acc-2) é o dono real
      if (token === "tok-acc-2") return { seller_id: 2222, status: "active" } as MLItemSnapshot;
      throw new Error("not your item");
    });

    const result = await findCorrectMLAccount({
      userId: "u1",
      currentAccountId: "acc-1",
      externalListingId: "MLB123",
      deps: {
        findAccounts: async () => [
          acc("acc-1", "1111"),
          acc("acc-2", "2222"),
          acc("acc-3", "3333"),
        ],
        getItemDetails,
      },
    });

    expect(result.repaired).toBe(true);
    expect(result.newAccountId).toBe("acc-2");
    expect(result.newAccountToken).toBe("tok-acc-2");
    expect(result.itemStatus).toBe("active");
    expect(result.itemSellerId).toBe(2222);
  });

  it("propaga itemStatus='closed' para que o caller trate como idempotente", async () => {
    const result = await findCorrectMLAccount({
      userId: "u1",
      currentAccountId: "acc-1",
      externalListingId: "MLB6658891678",
      deps: {
        findAccounts: async () => [
          acc("acc-jotabe", "1289108824"),
          acc("acc-desmonte", "2985478180"),
        ],
        getItemDetails: async () => ({
          seller_id: 2985478180,
          status: "closed",
          title: "Moldura Painel Peugeot 206 207",
        }) as MLItemSnapshot,
      },
    });
    expect(result.repaired).toBe(true);
    expect(result.newAccountId).toBe("acc-desmonte");
    expect(result.itemStatus).toBe("closed");
  });

  it("ignora conta atual e contas sem accessToken", async () => {
    const getItemDetails = vi.fn(async () => ({ seller_id: 9999 }) as MLItemSnapshot);
    const result = await findCorrectMLAccount({
      userId: "u1",
      currentAccountId: "acc-1",
      externalListingId: "MLB123",
      deps: {
        findAccounts: async () => [
          acc("acc-1", "1111"),               // atual → skip
          { id: "acc-no-token", externalUserId: "2222", accessToken: null }, // sem token → skip
          { id: "acc-empty-token", externalUserId: "3333", accessToken: "" }, // vazio → skip
        ],
        getItemDetails,
      },
    });
    expect(getItemDetails).not.toHaveBeenCalled();
    expect(result.repaired).toBe(false);
  });

  it("comparação de seller_id funciona com tipos mistos (number/string)", async () => {
    const result = await findCorrectMLAccount({
      userId: "u1",
      currentAccountId: "acc-1",
      externalListingId: "MLB123",
      deps: {
        findAccounts: async () => [
          acc("acc-1", "1111"),
          acc("acc-2", "2222"),
        ],
        getItemDetails: async () => ({ seller_id: "2222" }) as MLItemSnapshot, // string
      },
    });
    expect(result.repaired).toBe(true);
    expect(result.newAccountId).toBe("acc-2");
  });

  it("se NENHUMA conta retorna match, repaired=false com reason explicativa", async () => {
    const result = await findCorrectMLAccount({
      userId: "u1",
      currentAccountId: "acc-1",
      externalListingId: "MLB123",
      deps: {
        findAccounts: async () => [acc("acc-1", "1111"), acc("acc-2", "2222")],
        getItemDetails: async () => ({ seller_id: 9999 }) as MLItemSnapshot, // outro seller
      },
    });
    expect(result.repaired).toBe(false);
    expect(result.reason).toMatch(/conta não conectada|deletado/);
  });

  it("falha em getItemDetails de uma conta não trava o loop — segue tentando", async () => {
    const calls: string[] = [];
    const getItemDetails = vi.fn(async (token: string) => {
      calls.push(token);
      if (token === "tok-acc-2") throw new Error("403 forbidden");
      if (token === "tok-acc-3") return { seller_id: 3333, status: "active" } as MLItemSnapshot;
      throw new Error("404 not found");
    });

    const result = await findCorrectMLAccount({
      userId: "u1",
      currentAccountId: "acc-1",
      externalListingId: "MLB123",
      deps: {
        findAccounts: async () => [
          acc("acc-1", "1111"),
          acc("acc-2", "2222"),
          acc("acc-3", "3333"),
          acc("acc-4", "4444"),
        ],
        getItemDetails,
      },
    });

    expect(result.repaired).toBe(true);
    expect(result.newAccountId).toBe("acc-3");
    // tentou acc-2 (erro), parou em acc-3 (match) — acc-4 não foi necessário
    expect(calls).toEqual(["tok-acc-2", "tok-acc-3"]);
  });
});
