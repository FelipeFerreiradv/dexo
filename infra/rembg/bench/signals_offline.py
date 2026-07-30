#!/usr/bin/env python3
"""Calibracao OFFLINE do score de confianca (PR 3 — modo observacao).

Calcula sinais + score para cada PNG RGBA de um diretorio (ex.: o golden da
Fase 0) e, com --corrupt, tambem para uma variante deterministicamente SUJA
(specks + nevoa + fragmento) de cada mascara — mostrando a separacao que o
score da entre mascara boa e ruim ANTES de qualquer roteamento existir.

Uso (dentro do container do sidecar, que ja tem mask_postprocess em /app):
  docker exec dexo-rembg-bench python /bench/signals_offline.py \
      --images /golden/core --corrupt
"""

import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image

for cand in ("/app", os.path.join(os.path.dirname(__file__), "..")):
    if os.path.exists(os.path.join(cand, "mask_postprocess.py")):
        sys.path.insert(0, cand)
        break

from mask_postprocess import confidence_score, mask_signals  # noqa: E402


def corrupt(alpha: np.ndarray, seed: int) -> np.ndarray:
    """Suja a mascara de forma deterministica: specks + nevoa + fragmento."""
    rng = np.random.default_rng(seed)
    out = alpha.copy()
    h, w = out.shape
    for _ in range(12):  # specks solidos espalhados
        y, x = int(rng.integers(0, h - 6)), int(rng.integers(0, w - 6))
        out[y : y + 5, x : x + 5] = 255
    y0, x0 = int(rng.integers(0, h // 2)), int(rng.integers(0, w // 2))
    out[y0 : y0 + h // 4, x0 : x0 + w // 4] = np.maximum(
        out[y0 : y0 + h // 4, x0 : x0 + w // 4], 90
    )  # nevoa intermediaria
    out[h - h // 6 :, : w // 5] = 200  # fragmento grande tocando a borda
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True, help="dir com PNGs RGBA")
    ap.add_argument("--corrupt", action="store_true")
    # Default = so os cutouts: o sidecar calcula o score ANTES da sombra, e a
    # sombra adiciona enormes areas de alpha suave por design — pontuar os
    # .shadow.png offline nao representa o que roda em producao.
    ap.add_argument("--pattern", default="*.cutout.png")
    args = ap.parse_args()

    paths = sorted(glob.glob(os.path.join(args.images, args.pattern)))
    if not paths:
        print(f"nenhum PNG em {args.images}", file=sys.stderr)
        sys.exit(1)

    header = f"{'arquivo':<44} {'score':>6}  sinais"
    if args.corrupt:
        header += f"  |  {'score_sujo':>10}"
    print(header)
    scores, dirty_scores = [], []
    for i, p in enumerate(paths):
        rgba = np.array(Image.open(p).convert("RGBA"))
        alpha = rgba[..., 3]
        s = mask_signals(alpha)
        sc = confidence_score(s)
        scores.append(sc)
        line = (
            f"{os.path.basename(p):<44} {sc:>6.3f}  "
            + ";".join(f"{k}={v}" for k, v in s.items())
        )
        if args.corrupt:
            dsc = confidence_score(mask_signals(corrupt(alpha, seed=i)))
            dirty_scores.append(dsc)
            line += f"  |  {dsc:>10.3f}"
        print(line)

    print(
        f"\nlimpo:  min={min(scores):.3f} mediana={sorted(scores)[len(scores)//2]:.3f}"
    )
    if dirty_scores:
        print(
            f"sujo:   max={max(dirty_scores):.3f} "
            f"mediana={sorted(dirty_scores)[len(dirty_scores)//2]:.3f}"
        )
        print(
            "separacao (min limpo - max sujo): "
            f"{min(scores) - max(dirty_scores):+.3f}"
        )


if __name__ == "__main__":
    main()
