/**
 * Micro-bench do custo acessório no Node (Fase 0 — alvos das otimizações A2/A4).
 *
 * Quantifica, isoladamente, dois custos que o sidecar NÃO cobre:
 *   A2 — re-encode de PNG: hoje o serviço re-encoda o PNG que o sidecar já
 *        encodou, com { compressionLevel: 9, adaptiveFiltering: true }. Compara
 *        contra (i) nível 6 sem adaptiveFiltering e (ii) passthrough (só ler
 *        metadata, sem re-encodar). Mede tempo E bytes resultantes.
 *   A4 — decode redundante: hoje há um `sharp(buf).metadata()` extra sobre o
 *        input. Mede quanto custa esse decode-só-pra-metadata.
 *
 * Roda onde o sharp existe (node_modules) — ex. na raiz do repo:
 *   npx tsx infra/rembg/bench/node-encode-bench.ts \
 *     --cutout caminho/para/recorte.png --input caminho/para/foto-original.jpg \
 *     --iters 20 --warmup 3
 *
 * `--cutout` deve ser uma saída REAL do sidecar (PNG RGBA ~1600px, idealmente
 * a versão com sombra, que é o caso mais pesado). `--input` deve ser uma foto
 * de produto representativa (a entrada do upload, antes do resize).
 */
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import sharp from "sharp";

interface Args {
  cutout?: string;
  input?: string;
  iters: number;
  warmup: number;
}

function parseArgs(): Args {
  const a: Args = { iters: 20, warmup: 3 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--cutout") (a.cutout = v), i++;
    else if (k === "--input") (a.input = v), i++;
    else if (k === "--iters") (a.iters = Number(v)), i++;
    else if (k === "--warmup") (a.warmup = Number(v)), i++;
  }
  return a;
}

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function timeIt(
  label: string,
  iters: number,
  warmup: number,
  fn: () => Promise<number | void>,
): Promise<void> {
  const samples: number[] = [];
  let lastBytes: number | void = undefined;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    lastBytes = await fn();
    const dt = performance.now() - t0;
    if (i >= warmup) samples.push(dt);
  }
  const extra = typeof lastBytes === "number" ? `  bytes=${lastBytes}` : "";
  console.log(
    `  ${label.padEnd(28)} mediana=${median(samples)
      .toFixed(1)
      .padStart(8)} ms${extra}`,
  );
}

async function main() {
  const args = parseArgs();
  console.log(`Node encode/decode micro-bench — iters=${args.iters} warmup=${args.warmup}`);

  if (args.cutout) {
    const cutout = await readFile(args.cutout);
    const meta = await sharp(cutout).metadata();
    console.log(
      `\n[A2] re-encode do recorte (${meta.width}x${meta.height}, ${cutout.length} bytes de entrada):`,
    );
    await timeIt("reencode atual (lvl9+adapt)", args.iters, args.warmup, async () => {
      const out = await sharp(cutout)
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
      return out.length;
    });
    await timeIt("reencode lvl6 sem adapt", args.iters, args.warmup, async () => {
      const out = await sharp(cutout)
        .png({ compressionLevel: 6, adaptiveFiltering: false })
        .toBuffer();
      return out.length;
    });
    await timeIt("passthrough (só metadata)", args.iters, args.warmup, async () => {
      await sharp(cutout).metadata();
    });
    console.log(
      "  -> A2 = (reencode atual) - (passthrough). Compare TAMBÉM os bytes:\n" +
        "     se o passthrough (bytes do sidecar/PIL) inflar muito vs lvl9,\n" +
        "     considerar o meio-termo lvl6.",
    );
  } else {
    console.log("\n[A2] pulado (sem --cutout)");
  }

  if (args.input) {
    const input = await readFile(args.input);
    const meta = await sharp(input).metadata();
    console.log(
      `\n[A4] decode redundante do input (${meta.width}x${meta.height}, ${input.length} bytes):`,
    );
    await timeIt("sharp(input).metadata()", args.iters, args.warmup, async () => {
      await sharp(input).metadata();
    });
    console.log(
      "  -> A4 = custo desse decode extra por upload (hoje feito 1x a mais).",
    );
  } else {
    console.log("\n[A4] pulado (sem --input)");
  }

  console.log("\nPronto. Cole a saída de volta pro diagnóstico da Fase 0.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
