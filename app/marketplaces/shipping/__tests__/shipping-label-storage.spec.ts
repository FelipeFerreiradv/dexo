import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ShippingLabelStorageService } from "../shipping-label-storage.service";

describe("ShippingLabelStorageService", () => {
  let base: string;

  beforeAll(() => {
    base = path.join(os.tmpdir(), `dexo-ship-${Date.now()}`);
    process.env.SHIPPING_STORAGE_PATH = base;
  });

  afterAll(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("salva e relê o PDF em {userId}/etiquetas/{orderId}-{size}.pdf", async () => {
    const svc = new ShippingLabelStorageService();
    const bytes = Buffer.from("%PDF-1.4 etiqueta fake", "utf-8");

    const saved = await svc.saveLabelPdf("user1", "order1", "A4", bytes);
    expect(saved).toContain(
      path.join("user1", "etiquetas", "order1-A4.pdf"),
    );
    expect(fs.existsSync(saved)).toBe(true);

    const read = await svc.readFile(saved);
    expect(read).not.toBeNull();
    expect(read!.equals(bytes)).toBe(true);
  });

  it("coexistem A4 e térmico do mesmo pedido", async () => {
    const svc = new ShippingLabelStorageService();
    const a4 = await svc.saveLabelPdf("u", "o", "A4", Buffer.from("a4"));
    const th = await svc.saveLabelPdf("u", "o", "THERMAL", Buffer.from("th"));
    expect(a4).not.toBe(th);
    expect((await svc.readFile(a4))!.toString()).toBe("a4");
    expect((await svc.readFile(th))!.toString()).toBe("th");
  });

  it("readFile retorna null para caminho inexistente", async () => {
    const svc = new ShippingLabelStorageService();
    expect(await svc.readFile(path.join(base, "nao-existe.pdf"))).toBeNull();
  });
});
