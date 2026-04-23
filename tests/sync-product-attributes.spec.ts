import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import prisma from "@/app/lib/prisma";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

describe("SyncUseCase.syncMLProductData → ficha técnica secundária no PUT", () => {
  beforeEach(() => {
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockActiveItem = {
    id: "MLB-100",
    status: "active",
    available_quantity: 5,
    price: 99,
    title: "Antigo",
  };

  const baseProduct = {
    id: "prod-1",
    sku: "SKU-1",
    name: "Cubo de roda dianteiro",
    description: "Desc",
    price: 99,
    stock: 5,
  };

  it("envia attributes da ficha técnica filtrando os imutáveis (BRAND/MODEL/YEAR/PART_NUMBER/MPN/OEM/SELLER_SKU)", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(
      mockActiveItem as any,
    );
    const updateSpy = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue(mockActiveItem as any);

    const product = {
      ...baseProduct,
      attributes: {
        OCM: { value_name: "X-9999" },
        VOLTAGE: { value_id: "VID-12V", value_name: "12V" },
        BRAND: { value_name: "DEVE_SER_IGNORADO" },
        MODEL: { value_name: "DEVE_SER_IGNORADO" },
        YEAR: { value_name: "DEVE_SER_IGNORADO" },
        VEHICLE_YEAR: { value_name: "DEVE_SER_IGNORADO" },
        PART_NUMBER: { value_name: "DEVE_SER_IGNORADO" },
        MPN: { value_name: "DEVE_SER_IGNORADO" },
        OEM: { value_name: "DEVE_SER_IGNORADO" },
        SELLER_SKU: { value_name: "DEVE_SER_IGNORADO" },
      },
    };

    await (SyncUseCase as any).syncMLProductData(product, "MLB-100", {
      id: "acc-1",
      accessToken: "tok",
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const sentBody = updateSpy.mock.calls[0][2];
    expect(sentBody).toBeTruthy();
    expect(sentBody!.attributes).toBeTruthy();
    const ids = sentBody!.attributes!.map((a: any) => a.id).sort();
    expect(ids).toEqual(["OCM", "VOLTAGE"]);
    const ocm = sentBody!.attributes!.find((a: any) => a.id === "OCM");
    expect(ocm?.value_name).toBe("X-9999");
    const voltage = sentBody!.attributes!.find((a: any) => a.id === "VOLTAGE");
    expect(voltage?.value_id).toBe("VID-12V");
    expect(voltage?.value_name).toBe("12V");
  });

  it("não inclui attributes quando product.attributes está vazio/ausente", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(
      mockActiveItem as any,
    );
    const updateSpy = vi
      .spyOn(MLApiService, "updateItem")
      .mockResolvedValue(mockActiveItem as any);

    await (SyncUseCase as any).syncMLProductData(baseProduct, "MLB-100", {
      id: "acc-1",
      accessToken: "tok",
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const sentBody = updateSpy.mock.calls[0][2];
    expect(sentBody?.attributes).toBeUndefined();
  });

  it("retenta sem attributes se o ML rejeitar o PUT por causa deles", async () => {
    vi.spyOn(MLApiService, "getItemDetails").mockResolvedValue(
      mockActiveItem as any,
    );

    const err: any = new Error("invalid attribute");
    err.response = {
      status: 400,
      data: { message: "body.invalid_attribute" },
    };

    const updateSpy = vi
      .spyOn(MLApiService, "updateItem")
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(mockActiveItem as any);

    const product = {
      ...baseProduct,
      attributes: { OCM: { value_name: "X-1" } },
    };

    await (SyncUseCase as any).syncMLProductData(product, "MLB-100", {
      id: "acc-1",
      accessToken: "tok",
    });

    expect(updateSpy).toHaveBeenCalledTimes(2);
    const firstCallBody = updateSpy.mock.calls[0][2];
    expect(firstCallBody?.attributes).toBeTruthy();
    const secondCallBody = updateSpy.mock.calls[1][2];
    expect(secondCallBody?.attributes).toBeUndefined();
  });
});
