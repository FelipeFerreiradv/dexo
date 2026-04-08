import { afterAll, describe, expect, it } from "vitest";
import prisma from "../app/lib/prisma";
import {
  parsePurgeCliOptions,
  validatePurgeCliOptions,
} from "../scripts/purge-ml-desmonte";
import {
  buildStatusCounts,
  normalizeMarketplaceLabel,
  selectActionableItems,
  type InventoryRecord,
} from "../scripts/lib/jb-desmonte-purge";

const sampleInventory: InventoryRecord[] = [
  {
    id: "MLB-ACTIVE",
    seller_id: 2985478180,
    status: "active",
    sub_status: [],
    title: "Active item",
    price: 10,
    available_quantity: 1,
    seller_custom_field: null,
    permalink: "https://example.com/active",
    date_created: "2026-04-07T00:00:00.000Z",
    last_updated: "2026-04-07T00:00:00.000Z",
  },
  {
    id: "MLB-PAUSED",
    seller_id: 2985478180,
    status: "paused",
    sub_status: ["waiting_for_payment"],
    title: "Paused item",
    price: 20,
    available_quantity: 1,
    seller_custom_field: null,
    permalink: "https://example.com/paused",
    date_created: "2026-04-07T00:00:00.000Z",
    last_updated: "2026-04-07T00:00:00.000Z",
  },
  {
    id: "MLB-CLOSED",
    seller_id: 2985478180,
    status: "closed",
    sub_status: [],
    title: "Closed item",
    price: 30,
    available_quantity: 0,
    seller_custom_field: null,
    permalink: "https://example.com/closed",
    date_created: "2026-04-07T00:00:00.000Z",
    last_updated: "2026-04-07T00:00:00.000Z",
  },
  {
    id: "MLB-UNDER-REVIEW",
    seller_id: 2985478180,
    status: "under_review",
    sub_status: ["forbidden"],
    title: "Under review item",
    price: 40,
    available_quantity: 1,
    seller_custom_field: null,
    permalink: "https://example.com/under-review",
    date_created: "2026-04-07T00:00:00.000Z",
    last_updated: "2026-04-07T00:00:00.000Z",
  },
  {
    id: "MLB-INACTIVE",
    seller_id: 2985478180,
    status: "inactive",
    sub_status: ["waiting_for_patch"],
    title: "Inactive item",
    price: 50,
    available_quantity: 1,
    seller_custom_field: null,
    permalink: "https://example.com/inactive",
    date_created: "2026-04-07T00:00:00.000Z",
    last_updated: "2026-04-07T00:00:00.000Z",
  },
];

describe("purge helpers", () => {
  it("classifies only active and paused items as actionable", () => {
    const selection = selectActionableItems(sampleInventory, 1);

    expect(selection.actionable.map((item) => item.id)).toEqual([
      "MLB-ACTIVE",
      "MLB-PAUSED",
    ]);
    expect(selection.selected.map((item) => item.id)).toEqual(["MLB-ACTIVE"]);
    expect(selection.skippedByLimit.map((item) => item.id)).toEqual([
      "MLB-PAUSED",
    ]);
    expect(selection.skippedNonActionable.map((item) => item.id)).toEqual([
      "MLB-CLOSED",
      "MLB-UNDER-REVIEW",
      "MLB-INACTIVE",
    ]);
  });

  it("builds status counts for every observed status", () => {
    expect(buildStatusCounts(sampleInventory)).toEqual({
      active: 1,
      paused: 1,
      closed: 1,
      under_review: 1,
      inactive: 1,
    });
  });

  it("parses legacy --max as the actionable limit alias", () => {
    const options = parsePurgeCliOptions(["--dry-run", "--max", "25"]);

    expect(options.actionableLimit).toBe(25);
    expect(options.usedLegacyMaxAlias).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  it("requires the explicit environment gate for confirmed execution", () => {
    const options = parsePurgeCliOptions(
      ["--confirm", "--account-id", "acc-1"],
      {},
    );

    expect(() => validatePurgeCliOptions(options)).toThrow(
      "CONFIRM_JB_DESMONTE_PURGE=true",
    );
  });

  it("requires a reviewed account id for confirmed execution", () => {
    const options = parsePurgeCliOptions(["--confirm"], {
      CONFIRM_JB_DESMONTE_PURGE: "true",
    });

    expect(() => validatePurgeCliOptions(options)).toThrow("--account-id");
  });

  it("normalizes spacing and casing before comparison", () => {
    expect(normalizeMarketplaceLabel("  jotabe   autopecas  ")).toBe(
      "JOTABE AUTOPECAS",
    );
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
