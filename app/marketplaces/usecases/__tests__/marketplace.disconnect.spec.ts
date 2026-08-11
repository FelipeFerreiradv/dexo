import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

vi.mock("../../repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findByIdAndUser: vi.fn(),
    findByUserIdAndPlatform: vi.fn(),
    deleteAccount: vi.fn().mockResolvedValue({}),
    findAllByUserIdAndPlatform: vi.fn().mockResolvedValue([]),
  },
}));

import { MarketplaceRepository } from "../../repositories/marketplace.repository";
import { MarketplaceUseCase } from "../marketplace.usercase";

describe("MarketplaceUseCase.disconnectAccount — guarda de plataforma", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (MarketplaceRepository.deleteAccount as any).mockResolvedValue({});
    (MarketplaceRepository.findAllByUserIdAndPlatform as any).mockResolvedValue(
      [],
    );
  });

  it("accountId de conta ML na rota OLX ⇒ NÃO apaga a conta ML", async () => {
    // O bug: DELETE /marketplace/olx?accountId=<id de conta ML> achava a conta
    // ML (mesmo usuário) e a apagava, respondendo "OLX desconectada".
    (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue({
      id: "acc-ml",
      platform: Platform.MERCADO_LIVRE,
    });

    await expect(
      MarketplaceUseCase.disconnectAccount("user-1", Platform.OLX, "acc-ml"),
    ).rejects.toThrow();

    expect(MarketplaceRepository.deleteAccount).not.toHaveBeenCalled();
  });

  it("accountId da plataforma certa ⇒ apaga a conta", async () => {
    (MarketplaceRepository.findByIdAndUser as any).mockResolvedValue({
      id: "acc-olx",
      platform: Platform.OLX,
    });

    await MarketplaceUseCase.disconnectAccount(
      "user-1",
      Platform.OLX,
      "acc-olx",
    );

    expect(MarketplaceRepository.deleteAccount).toHaveBeenCalledWith("acc-olx");
  });
});
