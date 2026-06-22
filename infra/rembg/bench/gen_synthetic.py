#!/usr/bin/env python3
"""
Gera imagens sinteticas pra COMPLEMENTAR o golden set (Fase 0).

Cobre as variacoes de tamanho/forma/fundo que importam pra LATENCIA e pro
estresse do recorte:
  - tamanho: pequena / media / grande (ate ~1600px, p/ exercitar o downscale).
  - forma:   "cheia" (cubo) vs "fina" (para-lama) — silhuetas bem diferentes.
  - fundo:   "simples" (solido claro) vs "complexo" (gradiente + formas + ruido).

ATENCAO: estas sinteticas cobrem TAMANHO/FORMA, nao substituem os CASOS DIFICEIS
REAIS (fundo baguncado, reflexo, peca fina de verdade) — esses o Felipe fornece.
Deterministico (seed fixa) pra reprodutibilidade.

Uso (dentro do container bench):
  python /bench/gen_synthetic.py --out /images/synthetic
"""

import argparse
import os

import numpy as np
from PIL import Image

SIZES = [("pequena", 400, 400), ("media", 1000, 1000), ("grande", 1600, 1100)]
SHAPES = ["cheia", "fina"]
BGS = ["simples", "complexo"]


def make_bg(w, h, kind, rng):
    if kind == "simples":
        base = np.full((h, w, 3), 235, np.float64)
        base += rng.normal(0, 1.5, (h, w, 3))  # textura minima de papel
        return np.clip(base, 0, 255)
    # complexo: gradiente diagonal + circulos translucidos + ruido
    gx = np.linspace(60, 200, w)
    gy = np.linspace(90, 230, h)
    grad = (gx[None, :] + gy[:, None]) / 2.0
    base = np.dstack([grad * 0.9, grad * 0.8, grad * 1.0])
    for _ in range(6):
        cx, cy = rng.integers(0, w), rng.integers(0, h)
        r = rng.integers(min(w, h) // 8, min(w, h) // 3)
        color = rng.integers(40, 220, 3).astype(np.float64)
        yy, xx = np.ogrid[:h, :w]
        mask = ((xx - cx) ** 2 + (yy - cy) ** 2) <= r * r
        alpha = 0.25
        base[mask] = base[mask] * (1 - alpha) + color * alpha
    base += rng.normal(0, 6, (h, w, 3))
    return np.clip(base, 0, 255)


def draw_object(canvas, shape, rng):
    h, w = canvas.shape[:2]
    if shape == "cheia":
        ow, oh = int(w * 0.5), int(h * 0.5)
    else:  # fina (para-lama): barra longa e estreita
        ow, oh = int(w * 0.62), int(h * 0.16)
    x0 = (w - ow) // 2
    y0 = (h - oh) // 2
    # corpo com leve gradiente vertical + cor base
    body = rng.integers(60, 190, 3).astype(np.float64)
    shade = np.linspace(1.15, 0.7, oh)[:, None, None]  # (oh,1,1)
    block = np.clip(body[None, None, :] * shade, 0, 255)  # (oh,1,3)
    block = np.broadcast_to(block, (oh, ow, 3))  # (oh,ow,3) p/ indexar com `inside`
    # cantos arredondados (mascara)
    yy, xx = np.ogrid[:oh, :ow]
    rad = max(4, min(ow, oh) // 8)
    inside = np.ones((oh, ow), bool)
    for cx, cy in [(rad, rad), (ow - rad, rad), (rad, oh - rad), (ow - rad, oh - rad)]:
        corner = ((xx - cx) ** 2 + (yy - cy) ** 2) > rad * rad
        near_x = (xx < rad) if cx == rad else (xx > ow - rad)
        near_y = (yy < rad) if cy == rad else (yy > oh - rad)
        inside &= ~(corner & near_x & near_y)
    region = canvas[y0 : y0 + oh, x0 : x0 + ow]
    region[inside] = block[inside]
    # highlight
    hl = slice(oh // 8, oh // 3)
    region[hl] = np.clip(region[hl] + 35, 0, 255)
    canvas[y0 : y0 + oh, x0 : x0 + ow] = region
    return canvas


def main():
    ap = argparse.ArgumentParser(description="Gera imagens sinteticas (Fase 0).")
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=20260622)
    ap.add_argument("--quality", type=int, default=90)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    n = 0
    for sname, w, h in SIZES:
        for shape in SHAPES:
            for bg in BGS:
                # seed deterministica por combinacao
                rng = np.random.default_rng(args.seed + n)
                canvas = make_bg(w, h, bg, rng)
                canvas = draw_object(canvas, shape, rng)
                img = Image.fromarray(canvas.astype(np.uint8))
                name = "syn_%s_%s_%s.jpg" % (sname, shape, bg)
                img.save(os.path.join(args.out, name), quality=args.quality)
                print("  %s (%dx%d)" % (name, w, h))
                n += 1
    print("Geradas %d imagens em %s" % (n, args.out))


if __name__ == "__main__":
    main()
