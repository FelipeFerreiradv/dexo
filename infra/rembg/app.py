"""
Dexo rembg sidecar.

Endpoints HTTP minimos pra remocao de fundo de imagens de produto.
Servico proposital: sem auth, sticky session pra reaproveitar o modelo em
memoria. Workers configuraveis (env REMBG_WORKERS, default 1; cada worker tem
sua sessao/modelo). Em CPU o birefnet e' memory-bound, entao +workers nao
acelerou o lote nos testes; subir REMBG_WORKERS so vale se o host tiver banda
de memoria sobrando.

POST /remove-bg  multipart 'file' image/*  -> image/png transparente
                 campo opcional 'add_shadow' (default false): adiciona uma
                 sombra projetada direcional (drop shadow) atras da peca.
                 Sem o campo => identico.
GET  /health     liveness

Modelo default: birefnet-general-lite (melhor borda + fundo complexo; pico
~8.5GB RAM em CPU — viavel em servidor com folga, ex. KVM8/32GB). Alternativa
leve: isnet-general-use (~1.6GB / ~1s) via env REMBG_MODEL ou --build-arg,
desde que pre-baixado no build (ver Dockerfile).

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
from time import perf_counter

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
MODEL_NAME = os.getenv("REMBG_MODEL", "birefnet-general-lite")

# Profiling opt-in (Fase 0): REMBG_PROFILE=true mede o tempo de cada estagio do
# /remove-bg e expoe no header de resposta `X-Rembg-Timing` (+ log). Default OFF
# => zero trabalho extra e nenhuma mudanca no corpo/contrato. So pra diagnostico.
PROFILE_ENABLED = os.getenv("REMBG_PROFILE", "false").lower() == "true"

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


# Cor neutra escura da sombra (R,G,B) e opacidade (compoe ~cinza sobre branco).
SHADOW_COLOR = _parse_color(os.getenv("REMBG_SHADOW_COLOR", ""), (28, 28, 32))
SHADOW_OPACITY = float(os.getenv("REMBG_SHADOW_OPACITY", "0.45"))  # ~0.30-0.50
# Sombra projetada direcional (luz de cima-esquerda => sombra p/ baixo-direita).
# Offsets em fracao do tamanho do objeto; sinais invertem a direcao. Defaults
# calibrados p/ aparecer bem tanto em peca cheia (cubo) quanto fina (para-lama).
SHADOW_OFFSET_X = float(os.getenv("REMBG_SHADOW_OFFSET_X", "0.10"))  # + = direita
SHADOW_OFFSET_Y = float(os.getenv("REMBG_SHADOW_OFFSET_Y", "0.08"))  # + = baixo
# Inclinacao (shear) que projeta o topo da silhueta na direcao da sombra.
SHADOW_SHEAR = float(os.getenv("REMBG_SHADOW_SHEAR", "0.28"))
# Blur gaussiano: sigma = fator * maior lado do objeto (suaviza/espalha).
SHADOW_BLUR = float(os.getenv("REMBG_SHADOW_BLUR", "0.045"))
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


def _add_drop_shadow(rgba: np.ndarray) -> np.ndarray:
    """Sombra projetada direcional (estilo foto de produto): a silhueta (alpha)
    e' deslocada + inclinada (shear) na direcao da sombra, borrada (gaussiano) e
    tingida de cinza neutro semi-transparente, composta ATRAS do objeto num
    canvas expandido (dimensionado por bounding box, com cap no lado longo).
    Luz default vinda de cima-esquerda => sombra projeta p/ baixo-direita.
    Saida RGBA uint8."""
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
    base_y = float(y1)  # contato no "chao" = base do objeto (pivo do shear)

    dx = SHADOW_OFFSET_X * ow
    dy = SHADOW_OFFSET_Y * oh
    shx = SHADOW_SHEAR
    sigma = max(1.0, SHADOW_BLUR * max(ow, oh))
    blur_margin = int(np.ceil(3 * sigma))

    # Extensao do shear (maxima no topo do objeto: dist = base_y - y0).
    shear_ext = shx * (base_y - y0)  # >0 empurra o topo p/ direita
    left = int(np.ceil(blur_margin + max(0.0, -dx) + max(0.0, -shear_ext)))
    right = int(np.ceil(blur_margin + max(0.0, dx) + max(0.0, shear_ext)))
    top = int(np.ceil(blur_margin + max(0.0, -dy)))
    bottom = int(np.ceil(blur_margin + max(0.0, dy)))
    ox, oy = left, top
    new_w, new_h = w + left + right, h + top + bottom

    # Warp da silhueta -> sombra no canvas. Para o pixel original (x,y):
    #   canvas_x = ox + x - shx*y + dx + shx*base_y   (shear pivotando na base)
    #   canvas_y = oy + y + dy
    M = np.array([
        [1.0, -shx, ox + dx + shx * base_y],
        [0.0, 1.0, oy + dy],
    ], dtype=np.float32)
    sil = alpha.astype(np.float32) / 255.0
    shadow = cv2.warpAffine(sil, M, (new_w, new_h), flags=cv2.INTER_LINEAR,
                            borderValue=0.0)
    shadow = cv2.GaussianBlur(shadow, (0, 0), sigma)
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

    # Profiling opt-in: so preenche o dict de tempos quando PROFILE_ENABLED.
    prof = PROFILE_ENABLED
    timings: dict[str, float] = {}

    try:
        # Decodifica uma vez e passa PIL ao rembg — evita round-trip de PNG
        # (com bytes, o rembg encodaria o resultado em PNG e nos decodariamos
        # de novo). Com PIL, ele devolve PIL e vamos direto pra ndarray.
        t0 = perf_counter() if prof else 0.0
        src = Image.open(BytesIO(raw)).convert("RGB")
        if prof:
            timings["decode"] = perf_counter() - t0
            t0 = perf_counter()
        out = remove(src, session=_get_session(), post_process_mask=POST_PROCESS_MASK)
        if prof:
            timings["remove"] = perf_counter() - t0
            t0 = perf_counter()
        rgba = _to_rgba_array(out)
        if prof:
            timings["to_rgba"] = perf_counter() - t0
            t0 = perf_counter()
        if REFINE_ENABLED:
            rgba = _refine_edges(rgba)
        if prof:
            timings["refine"] = perf_counter() - t0
            t0 = perf_counter()
        if add_shadow and SHADOW_GLOBAL_ENABLED:
            try:
                rgba = _add_drop_shadow(rgba)
            except Exception:  # noqa: BLE001 — sombra best-effort, nao derruba o recorte
                pass
        if prof:
            timings["shadow"] = perf_counter() - t0
            t0 = perf_counter()
        png_bytes = _encode_png(rgba)
        if prof:
            timings["encode"] = perf_counter() - t0
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"rembg failed: {exc}") from exc

    headers = None
    if prof:
        header_val = ";".join(f"{k}={timings[k] * 1000:.1f}" for k in timings)
        headers = {"X-Rembg-Timing": header_val}
        print(
            f"[rembg-profile] {header_val} shadow_req={add_shadow} "
            f"out_bytes={len(png_bytes)}",
            flush=True,
        )

    return Response(content=png_bytes, media_type="image/png", headers=headers)
