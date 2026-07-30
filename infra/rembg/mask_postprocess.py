"""Pos-processamento TOPOLOGICO da mascara (alpha) do recorte.

POR QUE EXISTE (Fase 0, 29/07/2026)
-----------------------------------
Em fundo complexo o modelo devolve alpha com componentes parasitas (pedaco de
bancada, musgo, pe do fotografo) e pixels de baixa confianca espalhados pelo
quadro. Alem do defeito visual, isso tem um custo ESCONDIDO medido em producao:
o estagio de sombra dimensiona sigma/canvas pelo BBOX da silhueta — alpha
espalhado => bbox de quadro inteiro => warp+composite em canvas gigante. O
sigma-cap (incidente 24/07) limitou o blur, mas a cauda continuou: shadow de
17-48s medido em prod PO'S-cap. Colapsar a mascara aos componentes legitimos
mata o problema na RAIZ (bbox volta ao tamanho da peca).

O QUE FAZ (nesta ordem, tudo em ms — so cv2/numpy):
  1. Componentes conexos do alpha binarizado: descarta componentes com area
     menor que KEEP_RATIO x maior componente (E menor que MIN_AREA_PX).
     Pecas legitimamente multi-parte sobrevivem por construcao (limiar
     RELATIVO — qualquer parte >= 5% da maior fica).
  2. A keep-mask e' DILATADA (KEEP_DILATE_PX) antes de zerar o resto:
     preserva o anel suave de anti-alias da borda dos componentes mantidos.
  3. Furos internos: preenche apenas furos PEQUENOS (< HOLE_MAX_RATIO x maior
     componente), que NAO tocam a borda do quadro e cujo alpha medio original
     e' >= HOLE_MIN_ALPHA — furo REAL de parafuso tem alpha ~0 e NUNCA e'
     preenchido; "furo" de ruido tem alpha intermediario.
  4. (opt-in experimental) Supressao de sombra projetada REAL: pixels de alpha
     intermediario + baixa saturacao + abaixo do centroide da silhueta solida
     tem o alpha multiplicado por SUPPRESS_FACTOR. Fica atras de flag PROPRIA
     (REMBG_MASK_SHADOW_SUPPRESS) e NUNCA entra na exigencia do gate golden.

SEGURANCA / ZERO REGRESSAO
--------------------------
Killswitch master: REMBG_MASK_POSTPROCESS=false (default) => `postprocess_mask`
nem e' chamado pelo app.py — identidade absoluta com o comportamento atual.
Com a flag ON, recorte de fundo solido (alpha quase binario, 1 componente, sem
furos-ruido) passa quase intocado — e' o que o gate golden /golden/core exige.

Modulo PURO de proposito (sem FastAPI/rembg): os unittests rodam em qualquer
ambiente com numpy+cv2 (ex.: dentro da imagem do sidecar, sem carregar modelo).
"""

import os
from dataclasses import dataclass

import cv2
import numpy as np


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() == "true"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class MaskPostprocessConfig:
    """Tunables (todos com override por env, prefixo REMBG_MASK_)."""

    enabled: bool = False
    # Alpha >= bin_thresh conta como "solido" para a analise topologica.
    bin_thresh: int = 128
    # Componente sobrevive se area >= keep_ratio x maior componente...
    keep_ratio: float = 0.05
    # ...e tambem >= min_area_px (piso absoluto contra specks em imagem pequena).
    min_area_px: int = 64
    # Dilatacao da keep-mask (px) — preserva o anel suave da borda mantida.
    keep_dilate_px: int = 8
    # Furo interno e' preenchivel se area < hole_max_ratio x maior componente.
    hole_max_ratio: float = 0.001
    # ...e se o alpha MEDIO original do furo >= hole_min_alpha (furo real ~0).
    hole_min_alpha: int = 40
    # Abertura morfologica extra (px). Default 0 = off: o filtro de componentes
    # ja mata specks sem o risco de erodir hastes finas legitimas.
    open_px: int = 0
    # --- supressao de sombra projetada (opt-in EXPERIMENTAL, flag propria) ---
    shadow_suppress: bool = False
    shadow_alpha_lo: int = 30
    shadow_alpha_hi: int = 200
    # Saturacao aproximada (max(RGB)-min(RGB), 0-255) maxima de "sombra cinza".
    shadow_max_saturation: int = 60
    shadow_suppress_factor: float = 0.15
    # Raio (px) de protecao em volta de pixels FORTES (alpha > alpha_hi): o
    # anel anti-alias da propria peca cinza cai na faixa suprimivel — sem esta
    # protecao a borda inferior de peca metalica/preta seria esmagada.
    shadow_protect_px: int = 3

    @classmethod
    def from_env(cls) -> "MaskPostprocessConfig":
        return cls(
            enabled=_env_bool("REMBG_MASK_POSTPROCESS", False),
            bin_thresh=_env_int("REMBG_MASK_BIN_THRESH", 128),
            keep_ratio=_env_float("REMBG_MASK_KEEP_RATIO", 0.05),
            min_area_px=_env_int("REMBG_MASK_MIN_AREA_PX", 64),
            keep_dilate_px=_env_int("REMBG_MASK_KEEP_DILATE_PX", 8),
            hole_max_ratio=_env_float("REMBG_MASK_HOLE_MAX_RATIO", 0.001),
            hole_min_alpha=_env_int("REMBG_MASK_HOLE_MIN_ALPHA", 40),
            open_px=_env_int("REMBG_MASK_OPEN_PX", 0),
            shadow_suppress=_env_bool("REMBG_MASK_SHADOW_SUPPRESS", False),
            shadow_alpha_lo=_env_int("REMBG_MASK_SHADOW_ALPHA_LO", 30),
            shadow_alpha_hi=_env_int("REMBG_MASK_SHADOW_ALPHA_HI", 200),
            shadow_max_saturation=_env_int("REMBG_MASK_SHADOW_MAX_SAT", 60),
            shadow_suppress_factor=_env_float(
                "REMBG_MASK_SHADOW_SUPPRESS_FACTOR", 0.15
            ),
            shadow_protect_px=_env_int("REMBG_MASK_SHADOW_PROTECT_PX", 3),
        )


def postprocess_mask(
    rgba: np.ndarray, cfg: MaskPostprocessConfig
) -> np.ndarray:
    """Aplica a limpeza topologica no alpha. RGB NUNCA e' alterado.

    Retorna o proprio array de entrada quando nao ha nada a fazer (disabled,
    shape inesperado, alpha vazio ou nenhuma mudanca)."""
    if not cfg.enabled:
        return rgba
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        return rgba

    alpha = rgba[..., 3]
    h, w = alpha.shape
    solid = (alpha >= cfg.bin_thresh).astype(np.uint8)
    if not solid.any():
        return rgba  # nenhuma regiao solida — nada confiavel para ancorar

    # 1) componentes conexos: mantem os relevantes (limiar RELATIVO).
    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(
        solid, connectivity=8
    )
    areas = stats[1:, cv2.CC_STAT_AREA]  # [0] e' o fundo
    largest = int(areas.max())
    keep_thr = max(cfg.keep_ratio * largest, float(cfg.min_area_px))
    keep_ids = np.flatnonzero(areas >= keep_thr) + 1  # +1: pula o fundo
    # GUARD (achado da revisao adversarial): se NENHUM componente passa o piso
    # (inferencia degenerada — so specks, peca minuscula), zerar tudo entregaria
    # um PNG 100% transparente silenciosamente. Filosofia do modulo: sem ancora
    # confiavel => NAO MEXE.
    if keep_ids.size == 0:
        return rgba
    keep_solid = np.isin(labels, keep_ids).astype(np.uint8)

    # (opcional) abertura morfologica na mascara mantida.
    if cfg.open_px > 0:
        k = 2 * cfg.open_px + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        keep_solid = cv2.morphologyEx(keep_solid, cv2.MORPH_OPEN, kernel)
        # Mesmo guard: o open pode erodir o unico componente (haste fina).
        if not keep_solid.any():
            return rgba

    # 2) a dilatacao existe SO para preservar o anel SUAVE (alpha abaixo do
    # bin_thresh) na vizinhanca dos componentes mantidos — pixels SOLIDOS de
    # componentes descartados morrem mesmo dentro da area dilatada (um speck
    # a 8px da peca, ou DENTRO de um furo dela, nao pode ressuscitar).
    allowed = keep_solid
    if cfg.keep_dilate_px > 0:
        k = 2 * cfg.keep_dilate_px + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        allowed = cv2.dilate(keep_solid, kernel)

    out_alpha = alpha.copy()
    out_alpha[allowed == 0] = 0
    out_alpha[solid.astype(bool) & (keep_solid == 0)] = 0

    # 3) preenchimento de furos-ruido (furo real de parafuso e' preservado).
    # VETORIZADO (achado da revisao): a versao por-furo pagava um scan de
    # quadro inteiro POR componente inverso — grade de radiador/chapa perfurada
    # tem centenas/milhares de furos legitimos e viraria segundos de CPU no
    # worker unico. Com bincount, o custo e' O(H*W) total, independente do
    # numero de furos.
    solid_after = (out_alpha >= cfg.bin_thresh).astype(np.uint8)
    inv = (1 - solid_after).astype(np.uint8)
    n_inv, inv_labels, inv_stats, _ = cv2.connectedComponentsWithStats(
        inv, connectivity=4
    )
    if n_inv > 1:
        hole_area_max = max(1.0, cfg.hole_max_ratio * largest)
        lefts = inv_stats[1:, cv2.CC_STAT_LEFT]
        tops = inv_stats[1:, cv2.CC_STAT_TOP]
        rights = lefts + inv_stats[1:, cv2.CC_STAT_WIDTH]
        bottoms = tops + inv_stats[1:, cv2.CC_STAT_HEIGHT]
        inv_areas = inv_stats[1:, cv2.CC_STAT_AREA]
        # Toca a borda do quadro = fundo externo/abertura, nunca furo interno.
        interior = (lefts > 0) & (tops > 0) & (rights < w) & (bottoms < h)
        candidate = interior & (inv_areas < hole_area_max)
        if candidate.any():
            # Alpha medio por componente em UMA passada. A media e' sobre o
            # OUT_alpha (pos-descarte): um speck parasita culled DENTRO de um
            # furo real de parafuso ja esta zerado e nao infla a media — senao
            # ele "selaria" o furo como opaco e ressuscitaria o speck.
            flat_labels = inv_labels.ravel()
            sums = np.bincount(
                flat_labels,
                weights=out_alpha.ravel().astype(np.float64),
                minlength=n_inv,
            )
            counts = np.bincount(flat_labels, minlength=n_inv)
            means = sums[1:] / np.maximum(counts[1:], 1)
            fill_ids = (
                np.flatnonzero(candidate & (means >= cfg.hole_min_alpha)) + 1
            )
            if fill_ids.size:
                out_alpha[np.isin(inv_labels, fill_ids)] = 255

    # 4) supressao de sombra projetada real (opt-in experimental).
    if cfg.shadow_suppress:
        _suppress_projected_shadow(rgba, out_alpha, solid_after, cfg)

    if np.array_equal(out_alpha, alpha):
        return rgba
    out = rgba.copy()
    out[..., 3] = out_alpha
    return out


def _suppress_projected_shadow(
    rgba: np.ndarray,
    out_alpha: np.ndarray,
    solid: np.ndarray,
    cfg: MaskPostprocessConfig,
) -> None:
    """Atenua (in-place) pixels com cara de sombra projetada REAL: alpha
    intermediario + cor dessaturada + abaixo do centroide da silhueta solida.

    O caso que importa (foto B da Fase 0) e' a sombra DENSA que o modelo
    inclui com alpha acima do bin_thresh, CONECTADA a base da peca — por isso
    o filtro e' por FAIXA DE ALPHA (a peca opaca fica acima de alpha_hi e
    esta protegida), nao por "fora do solido". Heuristica deliberadamente
    conservadora e atras de flag propria (experimental)."""
    ys, _xs = np.nonzero(solid)
    if ys.size == 0:
        return
    centroid_y = int(ys.mean())

    rgb = rgba[..., :3].astype(np.int16)
    saturation = rgb.max(axis=2) - rgb.min(axis=2)

    candidate = (
        (out_alpha >= cfg.shadow_alpha_lo)
        & (out_alpha <= cfg.shadow_alpha_hi)
        & (saturation <= cfg.shadow_max_saturation)
    )
    candidate[:centroid_y, :] = False  # so abaixo do centroide

    # Protecao da borda anti-alias da PROPRIA peca (achado da revisao): o anel
    # suave de uma peca cinza/preta cai na faixa suprimivel. Pixels a ate
    # protect_px de um pixel FORTE (alpha > alpha_hi = corpo da peca) ficam
    # de fora; a sombra densa conectada segue suprimida a partir dessa faixa.
    if cfg.shadow_protect_px > 0:
        strong = (out_alpha > cfg.shadow_alpha_hi).astype(np.uint8)
        if strong.any():
            k = 2 * cfg.shadow_protect_px + 1
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
            near_strong = cv2.dilate(strong, kernel).astype(bool)
            candidate &= ~near_strong

    out_alpha[candidate] = (
        out_alpha[candidate].astype(np.float32) * cfg.shadow_suppress_factor
    ).astype(np.uint8)


# ---------------------------------------------------------------------------
# Score de confianca da mascara (PR 3 — MODO OBSERVACAO)
# ---------------------------------------------------------------------------
# Sinais baratos (O(H*W), ~10-30ms) calculados sobre o alpha FINAL (pos-refine,
# pre-sombra). O score NAO muda nenhum pixel nem decisao do pipeline: ele e'
# exposto em headers (X-Rembg-Confidence/X-Rembg-Signals) para o app Node
# LOGAR a decisao que o roteamento tomaria ("WOULD_REROUTE") e calibrar
# limiares com distribuicao real de producao antes de qualquer acao.
#
# Leitura dos sinais (mascara BOA = score alto):
#   amb         fracao de pixels de alpha intermediario => mascara "nebulosa"
#   ncomp       componentes relevantes (>0.1% do frame) => vazamento de fundo
#   cov         area do foreground / frame; fora de [0.05, 0.85] = suspeito
#   border_frac fracao da MOLDURA do frame com alpha alto => fundo incluido
#   holes_frac  area de furos internos / area do foreground => mascara furada

SIGNAL_WEIGHTS = {
    "amb": 0.35,
    "ncomp": 0.15,
    "cov": 0.20,
    "border": 0.20,
    "holes": 0.10,
}


def mask_signals(alpha: np.ndarray) -> dict:
    """Sinais crus do alpha (uint8 HxW). Puro e deterministico."""
    h, w = alpha.shape
    total = float(h * w)

    amb = float(np.count_nonzero((alpha > 12) & (alpha < 242))) / total

    solid = (alpha >= 128).astype(np.uint8)
    fg = float(np.count_nonzero(solid))
    cov = fg / total

    ncomp = 0
    holes_frac = 0.0
    if fg > 0:
        n_labels, _labels, stats, _ = cv2.connectedComponentsWithStats(
            solid, connectivity=8
        )
        areas = stats[1:, cv2.CC_STAT_AREA]
        ncomp = int(np.count_nonzero(areas > 0.001 * total))

        inv = (1 - solid).astype(np.uint8)
        n_inv, _il, inv_stats, _ = cv2.connectedComponentsWithStats(
            inv, connectivity=4
        )
        if n_inv > 1:
            lefts = inv_stats[1:, cv2.CC_STAT_LEFT]
            tops = inv_stats[1:, cv2.CC_STAT_TOP]
            rights = lefts + inv_stats[1:, cv2.CC_STAT_WIDTH]
            bottoms = tops + inv_stats[1:, cv2.CC_STAT_HEIGHT]
            interior = (lefts > 0) & (tops > 0) & (rights < w) & (bottoms < h)
            holes_frac = float(inv_stats[1:, cv2.CC_STAT_AREA][interior].sum()) / fg

    border = np.concatenate(
        [alpha[0, :], alpha[-1, :], alpha[1:-1, 0], alpha[1:-1, -1]]
    )
    border_frac = float(np.count_nonzero(border > 128)) / float(border.size)

    return {
        "amb": round(amb, 4),
        "ncomp": ncomp,
        "cov": round(cov, 4),
        "border": round(border_frac, 4),
        "holes": round(holes_frac, 4),
    }


def confidence_score(signals: dict) -> float:
    """Score em [0,1] a partir dos sinais (1 = mascara confiavel).

    Penalidades saturadas em 1 para nenhum sinal dominar sozinho. Pesos em
    SIGNAL_WEIGHTS; limiares iniciais calibrados com o golden da Fase 0
    (bench/signals_offline.py) — o roteamento so sera ligado depois da
    distribuicao real de producao (modo observacao)."""
    # Sem foreground solido nenhum, a mascara e' inutil por definicao — nao
    # ha o que os outros sinais "compensarem".
    if signals["cov"] <= 0.001:
        return 0.0
    # Ha foreground solido mas NENHUM componente relevante (>0.1% do frame):
    # e' a mascara "so specks" — fragmentos sem ancora, a pior classe (a mesma
    # que o guard do postprocess_mask deliberadamente nao toca). Sem este
    # curto-circuito ela escoraria ~0.95 e envenenaria a calibracao.
    if signals["ncomp"] == 0:
        return 0.0

    p_amb = min(signals["amb"] / 0.20, 1.0)
    p_ncomp = min(max(signals["ncomp"] - 1, 0) / 5.0, 1.0)
    cov = signals["cov"]
    if 0.05 <= cov <= 0.85:
        p_cov = 0.0
    else:
        dist = (0.05 - cov) if cov < 0.05 else (cov - 0.85)
        p_cov = min(dist / 0.15, 1.0)
    p_border = min(signals["border"] / 0.20, 1.0)
    p_holes = min(signals["holes"] / 0.05, 1.0)

    penalty = (
        SIGNAL_WEIGHTS["amb"] * p_amb
        + SIGNAL_WEIGHTS["ncomp"] * p_ncomp
        + SIGNAL_WEIGHTS["cov"] * p_cov
        + SIGNAL_WEIGHTS["border"] * p_border
        + SIGNAL_WEIGHTS["holes"] * p_holes
    )
    return round(max(0.0, min(1.0, 1.0 - penalty)), 4)
