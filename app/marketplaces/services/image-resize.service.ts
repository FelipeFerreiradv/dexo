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
 * curto. PNGs com alpha são achatados sobre fundo branco antes do encode JPEG
 * para evitar fundo preto (default do sharp ao converter alpha→opaque).
 */
export async function ensureMLMinImageSize(buf: Buffer): Promise<Buffer> {
  try {
    const sharp = await getSharp();
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    const hasAlpha = Boolean(meta.hasAlpha);

    if (w === 0 || h === 0) return buf;

    const meetsMin = w >= ML_MIN_IMAGE_PX && h >= ML_MIN_IMAGE_PX;
    if (meetsMin && !hasAlpha) return buf;

    let pipeline = sharp(buf);
    if (!meetsMin) {
      const resizeOpts =
        w <= h
          ? { width: ML_MIN_IMAGE_PX as number }
          : { height: ML_MIN_IMAGE_PX as number };
      pipeline = pipeline.resize(resizeOpts);
    }
    if (hasAlpha) {
      pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
    }
    const out = await pipeline.jpeg({ quality: 85 }).toBuffer();

    console.log(
      `[ImageResize] ${w}x${h} alpha=${hasAlpha} → out=${out.length} bytes (resize=${!meetsMin}, flatten=${hasAlpha})`,
    );
    return out;
  } catch (err) {
    console.warn(
      "[ImageResize] Falha ao processar, usando original:",
      err instanceof Error ? err.message : String(err),
    );
    return buf;
  }
}
