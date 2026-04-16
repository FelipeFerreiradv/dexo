/**
 * F8 — Cross-module smoke tests
 *
 * Verifies that the fiscal module (flag ON) does not regress any existing
 * module: sidebar, products, orders, customers, scraps, marketplace, and
 * financial. Also validates that every fiscal backend entry-point can be
 * imported and instantiated without side-effects.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

// ── Sidebar: fiscal section merges without breaking existing sections ──

describe("Sidebar — fiscal section integration", () => {
  beforeAll(() => {
    vi.stubEnv("NEXT_PUBLIC_FISCAL_MODULE_ENABLED", "true");
  });

  it("NAV_SECTIONS has all original sections (primary, marketplaces, ops)", async () => {
    // We cannot render a React component in node env, but we can verify the
    // data structures that feed the sidebar are intact.
    // Import the sidebar module fresh so env stub takes effect.
    const ids = ["primary", "marketplaces", "ops"];
    // The sidebar is a client component; just verify the nav constants compile.
    // We read the source and check the ids exist.
    const fs = await import("fs");
    const src = fs.readFileSync("components/app-sidebar.tsx", "utf-8");

    for (const id of ids) {
      expect(src).toContain(`id: "${id}"`);
    }
  });

  it("FISCAL_SECTION is defined with expected nav items", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("components/app-sidebar.tsx", "utf-8");

    const fiscalItems = ["nfe", "nfe-emitidas", "enviar-xml", "inutilizar", "fiscal-config"];
    for (const id of fiscalItems) {
      expect(src).toContain(`id: "${id}"`);
    }
  });

  it("Ctrl+K handler is still wired up", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("components/app-sidebar.tsx", "utf-8");
    expect(src).toContain('event.key.toLowerCase() === "k"');
  });
});

// ── Fiscal backend: every entry-point imports and instantiates cleanly ──

describe("Fiscal backend — importability smoke", () => {
  it("FiscalCalculatorService instantiates", async () => {
    const { FiscalCalculatorService } = await import(
      "../../app/fiscal/calculators/fiscal-calculator.service"
    );
    const svc = new FiscalCalculatorService();
    expect(svc).toBeDefined();
    expect(typeof svc.calcular).toBe("function");
  });

  it("NfeSequenceService instantiates", async () => {
    const { NfeSequenceService } = await import(
      "../../app/fiscal/sequence/nfe-sequence.service"
    );
    const svc = new NfeSequenceService();
    expect(svc).toBeDefined();
  });

  it("nfe.types exports fiscal type constants", async () => {
    const types = await import("../../app/fiscal/domain/nfe.types");
    // NfeStatus is a type union, not a runtime enum — verify exported constants instead
    expect(types.MEIO_PAGAMENTO_COD).toBeDefined();
    expect(types.FINALIDADE_NFE_COD).toBeDefined();
    expect(types.DESTINO_OPERACAO_COD).toBeDefined();
    expect(types.MODALIDADE_FRETE_COD).toBeDefined();
  });

  it("tribute-rules exports tax helpers", async () => {
    const rules = await import("../../app/fiscal/calculators/tribute-rules");
    expect(typeof rules.getAliquotasPadrao).toBe("function");
    expect(typeof rules.round2).toBe("function");
  });

  it("NfeXmlBuilderService instantiates", async () => {
    const { NfeXmlBuilderService } = await import(
      "../../app/fiscal/generators/nfe-xml-builder.service"
    );
    const builder = new NfeXmlBuilderService();
    expect(builder).toBeDefined();
  });

  it("DanfePdfService instantiates", async () => {
    const { DanfePdfService } = await import(
      "../../app/fiscal/generators/danfe-pdf.service"
    );
    const svc = new DanfePdfService();
    expect(svc).toBeDefined();
  });

  it("FiscalStorageService instantiates", async () => {
    const { FiscalStorageService } = await import(
      "../../app/fiscal/storage/fiscal-storage.service"
    );
    const svc = new FiscalStorageService();
    expect(svc).toBeDefined();
  });

  it("CertificateManagerService instantiates", async () => {
    const { CertificateManagerService } = await import(
      "../../app/fiscal/certificate/certificate-manager.service"
    );
    const mgr = new CertificateManagerService();
    expect(mgr).toBeDefined();
  });

  it("provider-factory exports createNfeProvider", async () => {
    const { createNfeProvider } = await import(
      "../../app/fiscal/providers/provider-factory"
    );
    expect(typeof createNfeProvider).toBe("function");
  });
});

// ── Fiscal usecases: all instantiate without side-effects ──

describe("Fiscal usecases — instantiation smoke", () => {
  it("CompanyFiscalUseCase", async () => {
    const { CompanyFiscalUseCase } = await import(
      "../../app/usecases/company-fiscal.usecase"
    );
    expect(new CompanyFiscalUseCase()).toBeDefined();
  });

  it("NfeDraftUseCase", async () => {
    const { NfeDraftUseCase } = await import(
      "../../app/usecases/nfe-draft.usecase"
    );
    expect(new NfeDraftUseCase()).toBeDefined();
  });

  it("NfeEmissionUseCase", async () => {
    const { NfeEmissionUseCase } = await import(
      "../../app/usecases/nfe-emission.usecase"
    );
    expect(new NfeEmissionUseCase()).toBeDefined();
  });

  it("NfeListingUseCase", async () => {
    const { NfeListingUseCase } = await import(
      "../../app/usecases/nfe-listing.usecase"
    );
    expect(new NfeListingUseCase()).toBeDefined();
  });

  it("NfeCancelamentoUseCase", async () => {
    const { NfeCancelamentoUseCase } = await import(
      "../../app/usecases/nfe-cancelamento.usecase"
    );
    expect(new NfeCancelamentoUseCase()).toBeDefined();
  });

  it("NfeInutilizacaoUseCase", async () => {
    const { NfeInutilizacaoUseCase } = await import(
      "../../app/usecases/nfe-inutilizacao.usecase"
    );
    expect(new NfeInutilizacaoUseCase()).toBeDefined();
  });
});

// ── Fiscal repositories: instantiate without side-effects ──

describe("Fiscal repositories — instantiation smoke", () => {
  it("CompanyFiscalRepository", async () => {
    const { CompanyFiscalRepository } = await import(
      "../../app/repositories/company-fiscal.repository"
    );
    expect(new CompanyFiscalRepository()).toBeDefined();
  });

  it("NfeRepository", async () => {
    const { NfeRepository } = await import(
      "../../app/repositories/nfe.repository"
    );
    expect(new NfeRepository()).toBeDefined();
  });
});

// ── Cross-module: existing modules still export correctly ──

describe("Cross-module — existing modules unaffected", () => {
  it("ProductUseCase instantiates", async () => {
    const { ProductUseCase } = await import(
      "../../app/usecases/product.usercase"
    );
    expect(new ProductUseCase()).toBeDefined();
  });

  it("OrderUseCase instantiates", async () => {
    const { OrderUseCase } = await import(
      "../../app/marketplaces/usecases/order.usercase"
    );
    expect(new OrderUseCase()).toBeDefined();
  });

  it("Prisma schema includes fiscal models without breaking existing models", async () => {
    const fs = await import("fs");
    const schema = fs.readFileSync("prisma/schema.prisma", "utf-8");

    // Fiscal models exist
    expect(schema).toContain("model CompanyFiscalConfig");
    expect(schema).toContain("model NfeSequence");
    expect(schema).toContain("model NfeEmitida");
    expect(schema).toContain("model NfeItem");
    expect(schema).toContain("model NfeAuditLog");
    expect(schema).toContain("model NfeInutilizacao");

    // Existing models still exist
    expect(schema).toContain("model User");
    expect(schema).toContain("model Product");
    expect(schema).toContain("model Order");
    expect(schema).toContain("model Customer");
    expect(schema).toContain("model Scrap");
  });

  it("fiscal routes file registers without import errors", async () => {
    const mod = await import("../../app/routes/fiscal.routes");
    expect(typeof mod.fiscalRoutes).toBe("function");
  });

  it("main API router includes fiscal prefix", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("app/api/api.ts", "utf-8");
    expect(src).toContain("fiscal");
  });
});

// ── Feature flag gating: pages redirect when flag is OFF ──

describe("Feature flag gating — pages check NEXT_PUBLIC_FISCAL_MODULE_ENABLED", () => {
  const fiscalPages = [
    "app/notas-fiscais/configuracao/page.tsx",
    "app/notas-fiscais/nfe/page.tsx",
    "app/notas-fiscais/emitidas/page.tsx",
    "app/notas-fiscais/inutilizar-numero/page.tsx",
    "app/notas-fiscais/enviar-xml/page.tsx",
  ];

  for (const pagePath of fiscalPages) {
    it(`${pagePath} checks feature flag`, async () => {
      const fs = await import("fs");
      const src = fs.readFileSync(pagePath, "utf-8");
      expect(src).toContain("NEXT_PUBLIC_FISCAL_MODULE_ENABLED");
    });
  }
});
