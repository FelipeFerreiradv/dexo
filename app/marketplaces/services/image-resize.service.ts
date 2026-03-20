/**
 * Serviço de redimensionamento de imagens para atender requisitos mínimos do
 * Mercado Livre (500px após trim de bordas). Usa 800px como margem de segurança.
 *
 * O import do sharp é cacheado em variável de módulo para evitar overhead de
 * dynamic import a cada chamada.
 */

const ML_MIN_IMAGE_PX = 800;

// Cache do módulo sharp — resolvido uma única vez
let _sharp: any = null;

async function getSharp() {
  if (_sharp) return _sharp;
  const mod = await import("sharp");
  _sharp = (mod as any).default || mod;
  return _sharp;
}

/**
 * Garante que a imagem tenha pelo menos ML_MIN_IMAGE_PX pixels no lado mais
 * curto. Se já for grande o suficiente retorna o buffer original sem cópia.
 */
export async function ensureMLMinImageSize(buf: Buffer): Promise<Buffer> {
  try {
    const sharp = await getSharp();
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;

    // Imagem já atende o mínimo — retorna sem processar (fast path)
    if (w >= ML_MIN_IMAGE_PX && h >= ML_MIN_IMAGE_PX) return buf;
    if (w === 0 || h === 0) return buf;

    // Redimensionar mantendo aspect ratio
    const resizeOpts =
      w <= h
        ? { width: ML_MIN_IMAGE_PX as number }
        : { height: ML_MIN_IMAGE_PX as number };

    const resized = await sharp(buf)
      .resize(resizeOpts)
      .jpeg({ quality: 85 })
      .toBuffer();

    console.log(
      `[ImageResize] ${w}x${h} → ${resizeOpts.width ?? "auto"}x${resizeOpts.height ?? "auto"} (${resized.length} bytes)`,
    );
    return resized;
  } catch (err) {
    console.warn(
      "[ImageResize] Falha ao redimensionar, usando original:",
      err instanceof Error ? err.message : String(err),
    );
    return buf;
  }
}
