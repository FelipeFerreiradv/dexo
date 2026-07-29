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
    keep = np.isin(labels, keep_ids).astype(np.uint8)

    # (opcional) abertura morfologica na mascara mantida.
    if cfg.open_px > 0:
        k = 2 * cfg.open_px + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        keep = cv2.morphologyEx(keep, cv2.MORPH_OPEN, kernel)

    # 2) dilata a keep-mask para nao decapitar o anel suave da borda.
    if cfg.keep_dilate_px > 0:
        k = 2 * cfg.keep_dilate_px + 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        keep = cv2.dilate(keep, kernel)

    out_alpha = alpha.copy()
    out_alpha[keep == 0] = 0

    # 3) preenchimento de furos-ruido (furo real de parafuso e' preservado).
    solid_after = (out_alpha >= cfg.bin_thresh).astype(np.uint8)
    inv = (1 - solid_after).astype(np.uint8)
    n_inv, inv_labels, inv_stats, _ = cv2.connectedComponentsWithStats(
        inv, connectivity=4
    )
    hole_area_max = max(1.0, cfg.hole_max_ratio * largest)
    for i in range(1, n_inv):
        x = inv_stats[i, cv2.CC_STAT_LEFT]
        y = inv_stats[i, cv2.CC_STAT_TOP]
        cw = inv_stats[i, cv2.CC_STAT_WIDTH]
        ch = inv_stats[i, cv2.CC_STAT_HEIGHT]
        area = inv_stats[i, cv2.CC_STAT_AREA]
        # Toca a borda do quadro = fundo externo/abertura, nunca furo interno.
        if x == 0 or y == 0 or x + cw >= w or y + ch >= h:
            continue
        if area >= hole_area_max:
            continue
        region = inv_labels == i
        # Furo REAL (parafuso/vazado): o modelo cravou alpha ~0 — preservar.
        if float(alpha[region].mean()) < cfg.hole_min_alpha:
            continue
        out_alpha[region] = 255

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

    out_alpha[candidate] = (
        out_alpha[candidate].astype(np.float32) * cfg.shadow_suppress_factor
    ).astype(np.uint8)
