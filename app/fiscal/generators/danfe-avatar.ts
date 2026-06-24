import type { DanfeAvatar } from "./danfe-v2-renderer";

// Cache do módulo sharp — resolvido sob demanda (mesmo padrão do
// image-resize.service), evitando carregar o binário nativo quando o avatar
// já é PNG/JPG e não precisa de transcode.
let _sharp: any = null;
async function getSharp() {
  if (_sharp) return _sharp;
  const mod = await import("sharp");
  _sharp = (mod as any).default || mod;
  return _sharp;
}

/**
 * Normaliza os bytes de uma imagem (avatar/logo do emitente) para um formato
 * que o pdf-lib consegue embutir no DANFE.
 *
 * - PNG (0x89 50 4E 47) e JPG (0xFF D8) passam direto, sem custo de transcode.
 * - WebP / GIF / AVIF / … são transcodados para PNG via sharp (já é dependência
 *   do app). Isto é necessário porque o próprio upload do sistema gera **WebP**
 *   quando "remover fundo" está desligado — caso típico de uma LOGO — e o
 *   pdf-lib só embute PNG/JPG. Sem isto a logo nunca aparece no DANFE.
 *
 * Best-effort: bytes ausentes/curtos ou falha de transcode → null (o renderer
 * cai nas iniciais). Nunca lança.
 */
export async function normalizeAvatarBytes(
  bytes: Uint8Array | null | undefined,
): Promise<DanfeAvatar | null> {
  if (!bytes || bytes.length < 4) return null;

  // JPG e PNG o pdf-lib embute nativamente.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes, format: "jpg" };
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { bytes, format: "png" };
  }

  // Demais formatos (WebP/GIF/AVIF/…) → transcoda para PNG.
  try {
    const sharp = await getSharp();
    const png = await sharp(Buffer.from(bytes)).png().toBuffer();
    return { bytes: new Uint8Array(png), format: "png" };
  } catch {
    return null;
  }
}
