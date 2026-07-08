#!/usr/bin/env node
// Remoção de fundo + sombra via POST /v1/images/process.
// A resposta É a imagem (bytes no corpo); os metadados vêm em headers X-*.
// Endpoint STATELESS — nada é salvo no servidor Dexo; você grava onde quiser.
//
// Uso:
//   API_BASE=http://localhost:3333 API_TOKEN=<jwt> \
//     node ./process-image.mjs ./parte.jpg ./saida.png
//   # ou, no modo legacy, use EMAIL no lugar de API_TOKEN:
//   EMAIL=usuario@empresa.com node ./process-image.mjs ./parte.jpg

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const API_BASE = process.env.API_BASE ?? "http://localhost:3333";
const TOKEN = process.env.API_TOKEN;
const EMAIL = process.env.EMAIL;

const inputPath = process.argv[2] ?? "./parte.jpg";
const outputPath = process.argv[3] ?? "./parte-processada.png";

function authHeaders() {
  if (TOKEN) return { Authorization: `Bearer ${TOKEN}` };
  if (EMAIL) return { email: EMAIL };
  throw new Error("Defina API_TOKEN=<jwt> ou EMAIL=<email cadastrado>");
}

async function processImage(
  localPath,
  { removeBackground = true, addShadow = true } = {},
) {
  const buf = await readFile(localPath);
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([buf], { type: "image/jpeg" }),
    basename(localPath),
  );
  fd.append("removeBackground", String(removeBackground));
  fd.append("addShadow", String(addShadow));

  const res = await fetch(`${API_BASE}/v1/images/process`, {
    method: "POST",
    headers: authHeaders(),
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`process falhou: HTTP ${res.status} ${text}`);
  }

  return {
    // O corpo é a imagem — os bytes vão para onde você quiser.
    bytes: Buffer.from(await res.arrayBuffer()),
    removedBackground: res.headers.get("x-removed-background") === "true",
    shadowApplied: res.headers.get("x-shadow-applied") === "true",
    format: res.headers.get("x-image-format"),
    width: res.headers.get("x-image-width"),
    height: res.headers.get("x-image-height"),
    warning: res.headers.get("x-warning"),
  };
}

const out = await processImage(inputPath);
if (!out.removedBackground) {
  // Degradação graceful: o sidecar estava indisponível; só otimizamos a imagem.
  console.warn("⚠ fundo não removido (degradação graceful):", out.warning);
}
await writeFile(outputPath, out.bytes);
console.log(
  `OK → ${outputPath} (${out.format}, ${out.width}x${out.height}, ` +
    `recorte=${out.removedBackground}, sombra=${out.shadowApplied})`,
);
