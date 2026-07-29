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

import anyio
import anyio.to_thread
import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from PIL import Image
from rembg import new_session, remove

from mask_postprocess import MaskPostprocessConfig, postprocess_mask

# Limites de tamanho:
# - 10 MB de input cobre folgadamente o limite do app (5 MB) e ainda
#   protege o sidecar de payloads patologicos.
MAX_BYTES = 10 * 1024 * 1024
MODEL_NAME = os.getenv("REMBG_MODEL", "birefnet-general-lite")

# Profiling opt-in (Fase 0): REMBG_PROFILE=true mede o tempo de cada estagio do
# /remove-bg e expoe no header de resposta `X-Rembg-Timing` (+ log). Default OFF
# => zero trabalho extra e nenhuma mudanca no corpo/contrato. So pra diagnostico.
PROFILE_ENABLED = os.getenv("REMBG_PROFILE", "false").lower() == "true"

# Tuning opt-in do ONNX Runtime (Camada A): REMBG_ORT_TUNE=true troca o
# new_session(MODEL_NAME) por uma sessao com SessionOptions explicito —
# execution_mode SEQUENTIAL, inter_op=REMBG_INTER_OP_THREADS (default 1) e
# intra_op=REMBG_INTRA_OP_THREADS — pra achar o "joelho" de saturacao de banda
# numa CPU memory-bound. MESMO modelo, MESMA saida (so conta de thread); o gate
# SSIM cobre qualquer drift de ponto-flutuante. Default OFF => comportamento
# IDENTICO ao de hoje (o new_session le OMP_NUM_THREADS e seta intra=inter=OMP).
ORT_TUNE = os.getenv("REMBG_ORT_TUNE", "false").lower() == "true"
ORT_INTRA_OP = int(os.getenv("REMBG_INTRA_OP_THREADS", "0")) or (os.cpu_count() or 8)
ORT_INTER_OP = int(os.getenv("REMBG_INTER_OP_THREADS", "1"))

# Fix raiz do ratchet de RSS (runbook 8.5 item 2, incidente 2026-07-24):
# a arena de CPU do ONNX Runtime (enable_cpu_mem_arena, default True) cresce e
# NUNCA devolve memoria ao SO — somada a fragmentacao do glibc, o RSS escala
# ate o mem_limit do container (OOM kill CONSTRAINT_MEMCG, medido 11,9GiB/12g).
# Desligar a arena troca o alocador (malloc por request), nao a matematica —
# saida identica (gate SSIM cobre). Opt-in => default off = comportamento
# byte-a-byte o de hoje. So tem efeito no caminho tunado (REMBG_ORT_TUNE=true).
ORT_DISABLE_ARENA = os.getenv("REMBG_ORT_DISABLE_ARENA", "false").lower() == "true"

# Offload opt-in da inferencia para thread (REMBG_ASYNC_OFFLOAD=true):
# o handler e' async mas remove() e' sincrono — hoje ele BLOQUEIA o event loop,
# entao /health nao responde durante uma inferencia (~9s) e requisicoes
# concorrentes empilham invisiveis na accept queue do kernel. Com offload:
#  - a inferencia roda em thread (serializada por um semaforo de 1 — mesmo
#    paralelismo de hoje, 1 inferencia por vez);
#  - o event loop fica livre => /health responde sempre;
#  - backpressure explicito: acima de REMBG_MAX_PENDING aguardando, responde
#    503 na hora (o app Node ja degrada graceful em 5xx) em vez de enfileirar
#    trabalho que ninguem vai esperar.
# Default off => fluxo identico ao atual. Ativar SO depois de golden+bench.
ASYNC_OFFLOAD = os.getenv("REMBG_ASYNC_OFFLOAD", "false").lower() == "true"
MAX_PENDING = int(os.getenv("REMBG_MAX_PENDING", "8"))

# Anti-ZUMBI (incidente 24/07 tarde): o caller (axios no Node) desiste em ~42s,
# mas a requisicao ja aceita continua na fila e o worker processa um recorte
# que NINGUEM vai receber. Sob demanda proxima da capacidade isso vira colapso:
# o worker passa o dia inteiro em trabalho-zumbi e todo pedido novo tambem
# estoura o orcamento. Com a flag, checamos se o cliente AINDA esta conectado
# imediatamente antes de iniciar a inferencia (ponto em que a requisicao pode
# ter esperado minutos na fila) e descartamos em ms os abandonados (499).
# Opt-in => default off = comportamento identico ao atual.
SKIP_DISCONNECTED = os.getenv("REMBG_SKIP_DISCONNECTED", "false").lower() == "true"

# Cap defensivo de megapixels (0 = off). MAX_BYTES limita bytes COMPRIMIDOS,
# nao pixels: um JPEG de 8MB pode ter 40MP e monopolizar o worker unico por
# varios minutos em full-res (comprovado em 24/07 com um teste manual de
# ~4min). O app SEMPRE manda <=1600px (~2MP), entao um cap de 6MP nao toca o
# trafego real — so protege de callers diretos/patologicos. Downscale LANCZOS
# preserva o contrato (PNG do recorte sai na resolucao reduzida).
MAX_INPUT_MP = float(os.getenv("REMBG_MAX_INPUT_MP", "0"))

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

# --- Pos-processamento topologico da mascara (opt-in) ----------------------
# Mata componentes parasitas (bancada/musgo/pe do fotografo), preenche
# furos-RUIDO (furo real de parafuso e' preservado) e, de quebra, colapsa o
# bbox da silhueta — que e' o que dimensiona o custo da sombra (cauda de
# 17-48s medida em prod POS-sigma-cap vinha de alpha espalhado pelo quadro).
# Killswitch master REMBG_MASK_POSTPROCESS=false (default) => estagio nem
# roda. Tunables e heuristicas: ver mask_postprocess.py.
MASK_POSTPROCESS_CFG = MaskPostprocessConfig.from_env()

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
# Cap do CUSTO do blur da sombra (0 = off). Incidente 24/07: recorte com alpha
# espalhado pelo quadro => bbox ~1600px => sigma ~72 => kernel ~433x433 num
# canvas float de ~4-5MP = ~34s SO no estagio shadow (medido em prod; normal
# e' ~1s). Com o cap, sigmas acima do teto desfocam numa versao REDUZIDA do
# canvas e re-ampliam — gaussiano e' passa-baixa: blur(sigma*s) em escala s
# == blur(sigma) em escala 1; para sombra suave e' visualmente identico e o
# custo fica limitado a ms. Opt-in => default off = comportamento atual.
SHADOW_SIGMA_CAP = float(os.getenv("REMBG_SHADOW_SIGMA_CAP", "0"))
# Cap do lado longo do resultado (nao estourar muito alem de ~1600px).
SHADOW_MAX_LONG = int(os.getenv("REMBG_SHADOW_MAX_LONG", "1600"))
SHADOW_ALPHA_THRESH = int(os.getenv("REMBG_SHADOW_ALPHA_THRESH", "16"))

app = FastAPI(title="Dexo rembg sidecar", version="2.1.0")

_session = None

# Estado do offload (so usado com REMBG_ASYNC_OFFLOAD=true). O contador e o
# lazy-init do semaforo mutam apenas no event loop (sem await entre leitura e
# escrita) => sem race. Semaforo lazy para nao depender de loop no import.
_pending = 0
_infer_lock = None


def _get_infer_lock():
    global _infer_lock
    if _infer_lock is None:
        _infer_lock = anyio.Semaphore(1)
    return _infer_lock


def _build_tuned_session():
    """Sessao do rembg com SessionOptions explicito (REMBG_ORT_TUNE).

    Resolve a MESMA classe de modelo que o new_session resolveria (por nome),
    so trocando a config de threads/exec-mode — nao muda o modelo nem a saida.
    Pin em CPUExecutionProvider (o que ja computa hoje; o AzureEP listado nao
    executa modelo local)."""
    import onnxruntime as ort
    from rembg.sessions import sessions_class

    session_class = None
    for sc in sessions_class:
        if sc.name() == MODEL_NAME:
            session_class = sc
            break
    if session_class is None:
        raise RuntimeError(f"classe de sessao nao encontrada p/ {MODEL_NAME!r}")

    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.intra_op_num_threads = ORT_INTRA_OP
    so.inter_op_num_threads = ORT_INTER_OP
    if ORT_DISABLE_ARENA:
        so.enable_cpu_mem_arena = False
    return session_class(MODEL_NAME, so, ["CPUExecutionProvider"])


def _get_session():
    """Lazy-init da sessao do rembg (carrega o ONNX uma unica vez)."""
    global _session
    if _session is None:
        if ORT_TUNE:
            try:
                _session = _build_tuned_session()
                print(
                    f"[rembg] ORT tune ON: intra_op={ORT_INTRA_OP} "
                    f"inter_op={ORT_INTER_OP} mode=SEQUENTIAL "
                    f"arena={'OFF' if ORT_DISABLE_ARENA else 'ON'}",
                    flush=True,
                )
            except Exception as exc:  # noqa: BLE001 — fallback seguro p/ o padrao
                print(
                    f"[rembg] ORT tune FALHOU ({exc!r}); usando new_session padrao",
                    flush=True,
                )
                _session = new_session(MODEL_NAME)
        else:
            if ORT_DISABLE_ARENA:
                print(
                    "[rembg] REMBG_ORT_DISABLE_ARENA=true sem REMBG_ORT_TUNE=true: "
                    "flag sem efeito (new_session padrao nao expoe SessionOptions)",
                    flush=True,
                )
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
        # Aditivo (diagnostico): config de threads quando REMBG_ORT_TUNE=true.
        "ort_tune": ORT_TUNE,
        "intra_op": ORT_INTRA_OP if ORT_TUNE else None,
        "inter_op": ORT_INTER_OP if ORT_TUNE else None,
        # Aditivos (incidente 2026-07-24): estado das flags novas + fila real.
        "arena_disabled": ORT_DISABLE_ARENA,
        "async_offload": ASYNC_OFFLOAD,
        "pending": _pending,
        "skip_disconnected": SKIP_DISCONNECTED,
        "max_input_mp": MAX_INPUT_MP,
        "shadow_sigma_cap": SHADOW_SIGMA_CAP,
        # Aditivos (pos-processamento topologico da mascara).
        "mask_postprocess": MASK_POSTPROCESS_CFG.enabled,
        "mask_shadow_suppress": MASK_POSTPROCESS_CFG.shadow_suppress,
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
    if SHADOW_SIGMA_CAP > 0 and sigma > SHADOW_SIGMA_CAP:
        # Blur bounded: reduz o canvas na razao cap/sigma, desfoca com o cap e
        # re-amplia. Equivalente ao gaussiano cheio (passa-baixa), custo O(cap).
        s = SHADOW_SIGMA_CAP / sigma
        small_w = max(1, int(round(new_w * s)))
        small_h = max(1, int(round(new_h * s)))
        small = cv2.resize(shadow, (small_w, small_h),
                           interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(small, (0, 0), SHADOW_SIGMA_CAP)
        shadow = cv2.resize(small, (new_w, new_h),
                            interpolation=cv2.INTER_LINEAR)
    else:
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


def _process_sync(
    raw: bytes, add_shadow: bool, prof: bool, timings: dict
) -> bytes:
    """Pipeline completo de uma inferencia (extraido byte-a-byte do handler).

    Sincrono de proposito: roda inline no event loop (default, comportamento
    historico) ou numa thread via anyio (REMBG_ASYNC_OFFLOAD=true)."""
    # Decodifica uma vez e passa PIL ao rembg — evita round-trip de PNG
    # (com bytes, o rembg encodaria o resultado em PNG e nos decodariamos
    # de novo). Com PIL, ele devolve PIL e vamos direto pra ndarray.
    t0 = perf_counter() if prof else 0.0
    src = Image.open(BytesIO(raw)).convert("RGB")
    if MAX_INPUT_MP > 0:
        mp = (src.width * src.height) / 1_000_000
        if mp > MAX_INPUT_MP:
            scale = (MAX_INPUT_MP / mp) ** 0.5
            src = src.resize(
                (max(1, int(src.width * scale)), max(1, int(src.height * scale))),
                Image.Resampling.LANCZOS,
            )
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
    # Pos-processamento topologico ANTES do refine (specks morrem antes do
    # despill trabalhar neles) e ANTES da sombra (bbox ja colapsado). Com a
    # flag OFF (default) o bloco inteiro e' pulado — inclusive a chave de
    # timing, para o X-Rembg-Timing ficar identico ao de hoje.
    if MASK_POSTPROCESS_CFG.enabled:
        try:
            rgba = postprocess_mask(rgba, MASK_POSTPROCESS_CFG)
        except Exception:  # noqa: BLE001 — best-effort, nunca derruba o recorte
            pass
        if prof:
            timings["postprocess"] = perf_counter() - t0
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
    return png_bytes


@app.post("/remove-bg")
async def remove_bg(
    request: Request,
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

    # Anti-zumbi: no momento em que este handler finalmente roda, a requisicao
    # pode ter esperado MINUTOS (fila serializada). Se o caller ja desistiu
    # (axios timeout -> conexao fechada), inferir seria trabalho para ninguem.
    if SKIP_DISCONNECTED and await request.is_disconnected():
        raise HTTPException(status_code=499, detail="client disconnected")

    try:
        if not ASYNC_OFFLOAD:
            # Caminho default: identico ao historico (inline no event loop).
            png_bytes = _process_sync(raw, add_shadow, prof, timings)
        else:
            # Offload: backpressure explicito ANTES de enfileirar + inferencia
            # em thread, serializada pelo semaforo (1 por vez, como hoje).
            global _pending
            if _pending >= MAX_PENDING:
                raise HTTPException(status_code=503, detail="rembg backlog full")
            _pending += 1
            try:
                async with _get_infer_lock():
                    # Re-checa apos a espera no semaforo (pode ter sido longa).
                    if SKIP_DISCONNECTED and await request.is_disconnected():
                        raise HTTPException(
                            status_code=499, detail="client disconnected"
                        )
                    png_bytes = await anyio.to_thread.run_sync(
                        _process_sync, raw, add_shadow, prof, timings
                    )
            finally:
                _pending -= 1
    except HTTPException:
        raise
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
