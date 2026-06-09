"""
Dexo rembg sidecar.

Endpoints HTTP minimos pra remocao de fundo de imagens de produto.
Servico proposital: sem auth, sticky session pra reaproveitar o modelo em
memoria (1 worker).

POST /remove-bg  multipart 'file' image/*  -> image/png transparente
                 campo opcional 'add_shadow' (default false): adiciona uma
                 sombra de contato suave sob a peca. Sem o campo => identico.
GET  /health     liveness

Modelo default: isnet-general-use (~1s/img, pico ~1.6GB RAM; borda melhor que
o u2net, fica boa com o refino). Para maxima qualidade em fundo complexo ha o
birefnet-general-lite (melhor, porem ~7s + pico ~8.5GB RAM) — troque via env
REMBG_MODEL ou --build-arg, desde que pre-baixado no build (ver Dockerfile).

Refino de borda (apos o recorte, controlado por env, com killswitch
REMBG_REFINE_EDGES=false):
  1) despill/decontaminacao: propaga a cor do foreground OPACO pra dentro do
     anel semi-transparente — mata o halo/franja da cor do fundo antigo;
  2) shaping do alpha: remap de contraste (tira a "neblina" de alpha baixo)
     + feather leve — borda nitida, sem serrilhado nem halo borrado.
E' conservador de proposito: em recorte de fundo solido (alpha quase binario)
e' quase identidade, entao NAO regride o caso que ja sai perfeito hoje.
"""

import os
from io import BytesIO

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image
from rembg import new_session, remove

# Limites de tamanho:
# - 10 MB de input cobre folgadamente o limite do app (5 MB) e ainda
#   protege o sidecar de payloads patologicos.
MAX_BYTES = 10 * 1024 * 1024
MODEL_NAME = os.getenv("REMBG_MODEL", "isnet-general-use")

# --- Tunables do refino de borda (env override; defaults calibrados) -------
# Killswitch: REMBG_REFINE_EDGES=false volta pro recorte cru do modelo.
REFINE_ENABLED = os.getenv("REMBG_REFINE_EDGES", "true").lower() != "false"
# Pixel com alpha >= ALPHA_OPAQUE (0-255) e' "foreground solido" e doa cor no
# despill.
ALPHA_OPAQUE = int(os.getenv("REMBG_ALPHA_OPAQUE", "250"))
# Iteracoes de propagacao da cor opaca pra dentro do anel semi-transparente.
DESPILL_ITERS = int(os.getenv("REMBG_DESPILL_ITERS", "3"))
# Erosao opcional (px) do alpha pra comer o anel mais externo contaminado.
EDGE_ERODE_PX = int(os.getenv("REMBG_EDGE_ERODE_PX", "0"))
# Remap de contraste do alpha (0-1): <= LO vira 0 (tira neblina), >= HI vira 1,
# interpola no meio. Endurece a transicao sem binarizar.
EDGE_ALPHA_LO = float(os.getenv("REMBG_EDGE_ALPHA_LO", "0.08"))
EDGE_ALPHA_HI = float(os.getenv("REMBG_EDGE_ALPHA_HI", "0.85"))
# Sigma (px) do gaussiano final no alpha — reintroduz ~1px de antialias limpo.
EDGE_FEATHER_PX = float(os.getenv("REMBG_EDGE_FEATHER_PX", "0.6"))
# post_process_mask do rembg (morfologia interna). Off por default p/ BiRefNet
# (o alpha ja vem fino); util no caminho fallback u2net/isnet.
POST_PROCESS_MASK = os.getenv("REMBG_POST_PROCESS_MASK", "false").lower() == "true"

# --- Sombra de contato (opt-in via form 'add_shadow') ----------------------
# Killswitch global: REMBG_SHADOW_ENABLED=false ignora add_shadow sem rebuild.
SHADOW_GLOBAL_ENABLED = os.getenv("REMBG_SHADOW_ENABLED", "true").lower() != "false"


def _parse_color(s: str, default):
    try:
        parts = [max(0, min(255, int(x))) for x in s.split(",")]
        if len(parts) == 3:
            return tuple(parts)
    except Exception:  # noqa: BLE001
        pass
    return default


# Cor neutra escura da sombra (R,G,B) e opacidade discreta (~0.30-0.45).
SHADOW_COLOR = _parse_color(os.getenv("REMBG_SHADOW_COLOR", ""), (18, 18, 22))
SHADOW_OPACITY = float(os.getenv("REMBG_SHADOW_OPACITY", "0.38"))
# Achatamento vertical da silhueta (sombra de chao) e largura relativa.
SHADOW_SQUASH = float(os.getenv("REMBG_SHADOW_SQUASH", "0.22"))
SHADOW_WIDTH = float(os.getenv("REMBG_SHADOW_WIDTH", "1.0"))
# Blur gaussiano: sigma = fator * maior lado do objeto.
SHADOW_BLUR = float(os.getenv("REMBG_SHADOW_BLUR", "0.04"))
# Desloca a sombra p/ baixo (fracao da altura do objeto) — peca "apoiada".
SHADOW_OFFSET_Y = float(os.getenv("REMBG_SHADOW_OFFSET_Y", "0.06"))
# Folgas do canvas pra caber a sombra (fracao do tamanho do objeto).
SHADOW_PAD_X = float(os.getenv("REMBG_SHADOW_PAD_X", "0.07"))
SHADOW_PAD_BOTTOM = float(os.getenv("REMBG_SHADOW_PAD_BOTTOM", "0.14"))
SHADOW_PAD_TOP = float(os.getenv("REMBG_SHADOW_PAD_TOP", "0.03"))
# Cap do lado longo do resultado (nao estourar muito alem de ~1600px).
SHADOW_MAX_LONG = int(os.getenv("REMBG_SHADOW_MAX_LONG", "1600"))
SHADOW_ALPHA_THRESH = int(os.getenv("REMBG_SHADOW_ALPHA_THRESH", "16"))

app = FastAPI(title="Dexo rembg sidecar", version="2.1.0")

_session = None


def _get_session():
    """Lazy-init da sessao do rembg (carrega o ONNX uma unica vez)."""
    global _session
    if _session is None:
        _session = new_session(MODEL_NAME)
    return _session


@app.on_event("startup")
def warmup():
    """Pre-carrega o modelo no boot pra que o primeiro request nao espere."""
    _get_session()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "refine": REFINE_ENABLED,
        "shadow": SHADOW_GLOBAL_ENABLED,
    }


def _to_rgba_array(out) -> np.ndarray:
    """Normaliza o retorno do rembg (bytes | PIL.Image | np.ndarray) para um
    array RGBA uint8 (H, W, 4)."""
    if isinstance(out, (bytes, bytearray)):
        return np.array(Image.open(BytesIO(bytes(out))).convert("RGBA"))
    if isinstance(out, Image.Image):
        return np.array(out.convert("RGBA"))
    arr = np.asarray(out)
    if arr.ndim == 2:  # mascara crua
        rgba = np.zeros((*arr.shape, 4), dtype=np.uint8)
        rgba[..., 3] = arr
        return rgba
    if arr.shape[2] == 3:  # sem alpha
        return np.dstack([arr, np.full(arr.shape[:2], 255, np.uint8)]).astype(np.uint8)
    return arr.astype(np.uint8)


def _refine_edges(rgba: np.ndarray) -> np.ndarray:
    """Limpa a borda do recorte (ver docstring do modulo). Conservador: em
    recorte de fundo solido e' quase identidade."""
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        return rgba
    rgb = rgba[..., :3].astype(np.uint8)
    alpha = rgba[..., 3].astype(np.uint8)

    # 1) Despill: propaga cor do foreground opaco pra dentro do anel de borda.
    opaque = alpha >= ALPHA_OPAQUE
    if DESPILL_ITERS > 0 and opaque.any() and not opaque.all():
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        filled = rgb.copy()
        known = opaque.copy()
        for _ in range(DESPILL_ITERS):
            dil = cv2.dilate(filled, kernel)
            dil_known = cv2.dilate(known.astype(np.uint8), kernel) > 0
            newly = dil_known & ~known
            if not newly.any():
                break
            filled[newly] = dil[newly]
            known = known | newly
        edge = ~opaque
        rgb[edge] = filled[edge]

    # 2) (opcional) erosao do alpha.
    af = alpha.astype(np.float32) / 255.0
    if EDGE_ERODE_PX > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        af = cv2.erode(af, k, iterations=EDGE_ERODE_PX)

    # 3) remap de contraste + feather leve.
    if EDGE_ALPHA_HI > EDGE_ALPHA_LO:
        af = np.clip((af - EDGE_ALPHA_LO) / (EDGE_ALPHA_HI - EDGE_ALPHA_LO), 0.0, 1.0)
    if EDGE_FEATHER_PX > 0:
        af = cv2.GaussianBlur(af, (0, 0), EDGE_FEATHER_PX)

    out_alpha = np.clip(af * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return np.dstack([rgb, out_alpha])


def _encode_png(rgba: np.ndarray) -> bytes:
    buf = BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG")
    return buf.getvalue()


def _paste_max(dst: np.ndarray, src: np.ndarray, top: int, left: int) -> None:
    """Cola `src` em `dst` na posicao (top,left) usando max, com clipping."""
    H, W = dst.shape[:2]
    sh, sw = src.shape[:2]
    y0, x0 = max(0, top), max(0, left)
    y1, x1 = min(H, top + sh), min(W, left + sw)
    if y0 >= y1 or x0 >= x1:
        return
    dst[y0:y1, x0:x1] = np.maximum(
        dst[y0:y1, x0:x1], src[y0 - top:y1 - top, x0 - left:x1 - left]
    )


def _alpha_over(fg: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Compoe fg sobre bg (ambos RGBA float, alpha 0-255; straight alpha)."""
    fa = fg[..., 3:4] / 255.0
    ba = bg[..., 3:4] / 255.0
    oa = fa + ba * (1.0 - fa)
    safe = np.clip(oa, 1e-6, 1.0)
    out = np.zeros_like(fg)
    out[..., :3] = (fg[..., :3] * fa + bg[..., :3] * ba * (1.0 - fa)) / safe
    out[..., 3] = oa[..., 0] * 255.0
    return out


def _add_contact_shadow(rgba: np.ndarray) -> np.ndarray:
    """Sombra de contato suave derivada do alpha: silhueta achatada, ancorada
    na base do objeto, blur gaussiano, opacidade discreta. Compoe o cutout por
    cima num canvas expandido (com cap no lado longo). Saida RGBA uint8."""
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        return rgba
    h, w = rgba.shape[:2]
    alpha = rgba[..., 3]
    ys, xs = np.where(alpha > SHADOW_ALPHA_THRESH)
    if ys.size == 0:
        return rgba  # nada visivel pra sombrear
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    oh, ow = y1 - y0 + 1, x1 - x0 + 1
    cx = (x0 + x1) / 2.0

    pad_x = int(round(ow * SHADOW_PAD_X))
    pad_bottom = int(round(oh * SHADOW_PAD_BOTTOM))
    pad_top = int(round(oh * SHADOW_PAD_TOP))
    new_h, new_w = h + pad_top + pad_bottom, w + 2 * pad_x
    ox, oy = pad_x, pad_top

    # Silhueta achatada (sombra de chao), centrada na base do objeto.
    sil = alpha.astype(np.float32) / 255.0
    sh_h = max(1, int(round(oh * SHADOW_SQUASH)))
    sh_w = max(1, int(round(ow * SHADOW_WIDTH)))
    sil_small = cv2.resize(sil[y0:y1 + 1, x0:x1 + 1], (sh_w, sh_h),
                           interpolation=cv2.INTER_AREA)

    shadow = np.zeros((new_h, new_w), np.float32)
    base_y = oy + y1
    sx = int(round(ox + cx - sh_w / 2.0))
    sy = int(round(base_y - sh_h / 2.0 + oh * SHADOW_OFFSET_Y))
    _paste_max(shadow, sil_small, sy, sx)

    sigma = max(1.0, SHADOW_BLUR * max(ow, oh))
    shadow = cv2.GaussianBlur(shadow, (0, 0), sigma)
    peak = float(shadow.max())
    if peak > 0:
        shadow /= peak  # normaliza: pico da sombra = SHADOW_OPACITY
    shadow = np.clip(shadow * SHADOW_OPACITY, 0.0, 1.0)

    bg = np.zeros((new_h, new_w, 4), np.float32)
    bg[..., 0], bg[..., 1], bg[..., 2] = SHADOW_COLOR
    bg[..., 3] = shadow * 255.0

    fg = np.zeros((new_h, new_w, 4), np.float32)
    fg[oy:oy + h, ox:ox + w] = rgba.astype(np.float32)

    out_u8 = np.clip(_alpha_over(fg, bg) + 0.5, 0, 255).astype(np.uint8)

    long_edge = max(new_h, new_w)
    if long_edge > SHADOW_MAX_LONG:
        s = SHADOW_MAX_LONG / float(long_edge)
        out_u8 = cv2.resize(
            out_u8,
            (max(1, int(round(new_w * s))), max(1, int(round(new_h * s)))),
            interpolation=cv2.INTER_AREA,
        )
    return out_u8


@app.post("/remove-bg")
async def remove_bg(
    file: UploadFile = File(...),
    add_shadow: bool = Form(False),
):
    # Aceita image/* e application/octet-stream (fallback comum quando o
    # cliente nao seta MIME). Outros tipos viram log + 400 com motivo
    # explicito pra facilitar diagnostico do lado do caller.
    ctype = (file.content_type or "").lower()
    if not (ctype.startswith("image/") or ctype == "application/octet-stream"):
        raise HTTPException(
            status_code=400,
            detail=f"unsupported content_type: {file.content_type!r}",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="payload too large")

    try:
        # Decodifica uma vez e passa PIL ao rembg — evita round-trip de PNG
        # (com bytes, o rembg encodaria o resultado em PNG e nos decodariamos
        # de novo). Com PIL, ele devolve PIL e vamos direto pra ndarray.
        src = Image.open(BytesIO(raw)).convert("RGB")
        out = remove(src, session=_get_session(), post_process_mask=POST_PROCESS_MASK)
        rgba = _to_rgba_array(out)
        if REFINE_ENABLED:
            rgba = _refine_edges(rgba)
        if add_shadow and SHADOW_GLOBAL_ENABLED:
            try:
                rgba = _add_contact_shadow(rgba)
            except Exception:  # noqa: BLE001 — sombra best-effort, nao derruba o recorte
                pass
        png_bytes = _encode_png(rgba)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"rembg failed: {exc}") from exc

    return Response(content=png_bytes, media_type="image/png")
