/**
 * Gera o PDF do documento de Ingestao de Pedidos para Suporte/Implantacao/CS.
 * Usa o template institucional de app/reports (capa, cabecalho, rodape, paleta).
 *
 *   npx tsx scripts/docs/gerar-doc-ingestao-pedidos.ts
 */
import fs from "fs";
import path from "path";

async function main() {
  const { gerarPdf } = await import("./doc-ingestao-pedidos");
  const buf = await gerarPdf();
  const destino = path.resolve(
    process.cwd(),
    "scripts/out/Dexo-Ingestao-de-Pedidos-Suporte-CS.pdf",
  );
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, buf);
  console.log(`PDF gerado: ${destino} (${(buf.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error("Falha ao gerar o PDF:", e?.message ?? e);
  process.exit(1);
});
