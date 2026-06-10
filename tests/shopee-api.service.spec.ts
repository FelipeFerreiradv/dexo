import { afterEach, describe, expect, it, vi } from "vitest";

import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";

describe("ShopeeApiService.getOrderDetails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("solicita item_list e campos necessarios para importar pedidos", async () => {
    const requestSpy = vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({
        error: "",
        message: "",
        response: { order_list: [] },
      });

    await ShopeeApiService.getOrderDetails("token-1", 123, ["ORDER-1"]);

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("/api/v2/order/get_order_detail?"),
      "token-1",
      123,
    );

    const requestPath = requestSpy.mock.calls[0]?.[1] as string;
    const query = new URL(`https://example.test${requestPath}`).searchParams;

    expect(query.get("order_sn_list")).toBe("ORDER-1");
    expect(query.get("response_optional_fields")).toBe(
      "item_list,buyer_username,total_amount",
    );
  });
});

describe("ShopeeApiService.getCategoryAttributes (migrado para get_attribute_tree)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chama /api/v2/product/get_attribute_tree (nao mais o get_attributes deprecated)", async () => {
    const requestSpy = vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({
        error: "",
        message: "",
        response: { list: [{ category_id: 102291, attribute_tree: [] }] },
      });

    await ShopeeApiService.getCategoryAttributes("token-1", 123, 102291, "pt-BR");

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [method, path] = requestSpy.mock.calls[0] as [string, string, ...any[]];
    expect(method).toBe("GET");
    expect(path).toContain("/api/v2/product/get_attribute_tree");
    expect(path).toContain("category_id_list=102291");
    expect(path).toContain("language=pt-BR");
    // Sanidade negativa: nao deve mais bater no endpoint descontinuado
    expect(path).not.toContain("/api/v2/product/get_attributes?");
  });

  it("mapeia formato novo (attribute_tree) para o formato antigo (attribute_list) que os consumers esperam", async () => {
    vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({
        error: "",
        message: "",
        response: {
          list: [
            {
              category_id: 102291,
              attribute_tree: [
                {
                  attribute_id: 4233,
                  name: "Auto-Part Number",
                  mandatory: true,
                  attribute_value_list: [],
                  attribute_info: { input_type: 3, attribute_unit_list: [] },
                },
                {
                  attribute_id: 4001,
                  name: "Marca",
                  mandatory: true,
                  attribute_value_list: [
                    { value_id: 10, name: "Chevrolet" },
                    { value_id: 11, name: "Fiat" },
                  ],
                  attribute_info: { input_type: 1 },
                },
              ],
            },
          ],
        },
      });

    const res = await ShopeeApiService.getCategoryAttributes("token", 1, 102291, "pt-BR");

    // Shape antigo preservado para retrocompat com ShopeeAttributeCatalogService,
    // listing.usercase.ts e tests/shopee-listing-attrs.spec.ts.
    expect(res.attribute_list).toHaveLength(2);
    expect(res.attribute_list[0]).toMatchObject({
      attribute_id: 4233,
      attribute_name: "Auto-Part Number", // antes "name" no novo formato
      is_mandatory: true, // antes "mandatory"
      attribute_value_list: [],
    });
    expect(res.attribute_list[1]).toMatchObject({
      attribute_id: 4001,
      attribute_name: "Marca",
      is_mandatory: true,
    });
    expect(res.attribute_list[1].attribute_value_list).toEqual([
      { value_id: 10, value_name: "Chevrolet", parent_attribute_id: 0, parent_value_id: 0, has_mandatory_children: false },
      { value_id: 11, value_name: "Fiat", parent_attribute_id: 0, parent_value_id: 0, has_mandatory_children: false },
    ]);
  });

  it("computa has_mandatory_children: valor com filho obrigatorio (recursivo) eh marcado true", async () => {
    vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({
        error: "",
        message: "",
        response: {
          list: [
            {
              category_id: 101251,
              attribute_tree: [
                {
                  attribute_id: 100408,
                  name: "Connection Type",
                  mandatory: true,
                  attribute_value_list: [
                    {
                      value_id: 2530,
                      name: "Wireless",
                      child_attribute_list: [
                        {
                          attribute_id: 101197,
                          name: "Registration ID",
                          mandatory: true,
                          attribute_value_list: [],
                        },
                      ],
                    },
                    { value_id: 16702, name: "Others" }, // sem filhos
                  ],
                },
              ],
            },
          ],
        },
      });

    const res = await ShopeeApiService.getCategoryAttributes("t", 1, 101251, "pt-BR");
    const conn = res.attribute_list[0];
    const wireless = conn.attribute_value_list.find((v) => v.value_id === 2530);
    const others = conn.attribute_value_list.find((v) => v.value_id === 16702);
    expect((wireless as any).has_mandatory_children).toBe(true);
    expect((others as any).has_mandatory_children).toBe(false);
  });

  it("has_mandatory_children=false quando filhos existem mas nenhum eh obrigatorio", async () => {
    vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({
        error: "",
        message: "",
        response: {
          list: [
            {
              category_id: 999,
              attribute_tree: [
                {
                  attribute_id: 1,
                  name: "Attr",
                  mandatory: true,
                  attribute_value_list: [
                    {
                      value_id: 5,
                      name: "ValComFilhoOpcional",
                      child_attribute_list: [
                        { attribute_id: 2, name: "Opt", mandatory: false, attribute_value_list: [] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      });

    const res = await ShopeeApiService.getCategoryAttributes("t", 1, 999);
    expect((res.attribute_list[0].attribute_value_list[0] as any).has_mandatory_children).toBe(false);
  });

  it("retorna attribute_list vazio quando a categoria nao tem atributos (lista vazia legitima)", async () => {
    vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({
        error: "",
        message: "",
        response: { list: [{ category_id: 9999, attribute_tree: [] }] },
      });

    const res = await ShopeeApiService.getCategoryAttributes("token", 1, 9999);
    expect(res.attribute_list).toEqual([]);
  });

  it("propaga erro com mensagem amigavel quando a Shopee retorna error", async () => {
    vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({
        error: "error_invalid_category",
        message: "Invalid category ID",
        response: null,
      });

    await expect(
      ShopeeApiService.getCategoryAttributes("token", 1, 99999999),
    ).rejects.toThrow(/Erro ao buscar atributos da categoria.*Invalid category ID/);
  });
});

describe("ShopeeApiService.getRecentOrders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filtra localmente apenas status pos-venda da Shopee", async () => {
    vi.spyOn(ShopeeApiService, "getOrderList").mockResolvedValue({
      more: false,
      order_list: [
        { order_sn: "A", order_status: "READY_TO_SHIP", create_time: 1, update_time: 1 },
        { order_sn: "B", order_status: "UNPAID", create_time: 1, update_time: 1 },
        { order_sn: "C", order_status: "TO_CONFIRM_RECEIVE", create_time: 1, update_time: 1 },
      ],
    } as any);
    vi.spyOn(ShopeeApiService, "getOrderDetails").mockResolvedValue([
      { order_sn: "A", order_status: "READY_TO_SHIP", item_list: [] },
      { order_sn: "B", order_status: "UNPAID", item_list: [] },
      { order_sn: "C", order_status: "TO_CONFIRM_RECEIVE", item_list: [] },
    ] as any);

    const result = await ShopeeApiService.getRecentOrders("token-1", 123, 1);

    expect(ShopeeApiService.getOrderList).toHaveBeenCalledWith(
      "token-1",
      123,
      expect.not.objectContaining({ order_status: expect.anything() }),
    );
    expect(result.map((order: any) => order.order_sn)).toEqual(["A", "C"]);
  });
});
