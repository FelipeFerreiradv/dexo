#!/usr/bin/env python3
"""
Golden set + gate de qualidade (Fase 0).

A REGRA-MAE do projeto: zero regressao de qualidade. Este script congela a saida
ATUAL do sidecar (recorte + sombra) como "golden" e, depois de QUALQUER mudanca,
compara a nova saida contra o golden. Violacao = BLOQUEIO (exit code != 0).

Metricas (so numpy + cv2 + PIL — nada de scikit-image; roda dentro do container):
  - SSIM do RGB composto sobre BRANCO e sobre PRETO (pixel transparente tem RGB
    indefinido; compor sobre 2 fundos pega erro de cor que so aparece num deles).
  - SSIM do canal ALPHA isolado (e' onde halo/banding de matting se escondem).
  - L-inf e MAE do alpha (SSIM e' estrutural e pode passar com um halo fino;
    o L-inf pega diferenca absoluta de borda).
Limiares default: SSIM >= 0.995 (cada), alpha L-inf <= 2 (de 255), alpha MAE <= 0.5.

Subcomandos:
  save     congela o golden a partir de um diretorio de imagens-fonte.
  compare  re-roda as fontes e compara contra o golden salvo.

Uso (dentro do container bench):
  python /bench/golden.py save    --url http://127.0.0.1:8000/remove-bg \
                                   --images /images --out /golden
  python /bench/golden.py compare --url http://127.0.0.1:8000/remove-bg \
                                   --golden /golden
"""

import argparse
import glob
import os
import shutil
import sys
from io import BytesIO

import cv2
import numpy as np
from PIL import Image

# Reusa o cliente HTTP do harness (mesmo diretorio => importavel).
from bench import post_remove_bg

IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
VARIANTS = [("cutout", False), ("shadow", True)]  # (sufixo, add_shadow)


def find_images(path):
    out = []
    for ext in IMG_EXTS:
        out.extend(glob.glob(os.path.join(path, "**", "*" + ext), recursive=True))
        out.extend(glob.glob(os.path.join(path, "*" + ext)))
    return sorted(set(out))


def load_rgba(data_or_path):
    if isinstance(data_or_path, (bytes, bytearray)):
        img = Image.open(BytesIO(bytes(data_or_path)))
    else:
        img = Image.open(data_or_path)
    return np.array(img.convert("RGBA"))


def ssim(a, b):
    """SSIM de canal unico (Wang et al.), janela gaussiana 11/sigma 1.5.
    Entradas: arrays 2D float, faixa 0-255."""
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    k = (11, 11)
    s = 1.5
    mu_a = cv2.GaussianBlur(a, k, s)
    mu_b = cv2.GaussianBlur(b, k, s)
    mu_a2, mu_b2, mu_ab = mu_a * mu_a, mu_b * mu_b, mu_a * mu_b
    var_a = cv2.GaussianBlur(a * a, k, s) - mu_a2
    var_b = cv2.GaussianBlur(b * b, k, s) - mu_b2
    cov = cv2.GaussianBlur(a * b, k, s) - mu_ab
    num = (2 * mu_ab + c1) * (2 * cov + c2)
    den = (mu_a2 + mu_b2 + c1) * (var_a + var_b + c2)
    return float((num / den).mean())


def composite(rgba, bg):
    """Compoe RGBA (uint8) sobre fundo escalar bg -> HxWx3 float 0-255."""
    a = rgba[..., 3:4].astype(np.float64) / 255.0
    rgb = rgba[..., :3].astype(np.float64)
    return rgb * a + float(bg) * (1.0 - a)


def rgb_ssim_over(new_rgba, gold_rgba, bg):
    cn = composite(new_rgba, bg)
    cg = composite(gold_rgba, bg)
    return float(np.mean([ssim(cn[..., c], cg[..., c]) for c in range(3)]))


def compare_pair(new_rgba, gold_rgba):
    """Retorna dict de metricas comparando nova saida vs golden."""
    if new_rgba.shape != gold_rgba.shape:
        return {"shape_mismatch": (new_rgba.shape, gold_rgba.shape)}
    ssim_white = rgb_ssim_over(new_rgba, gold_rgba, 255)
    ssim_black = rgb_ssim_over(new_rgba, gold_rgba, 0)
    an = new_rgba[..., 3].astype(np.float64)
    ag = gold_rgba[..., 3].astype(np.float64)
    ssim_alpha = ssim(an, ag)
    alpha_linf = float(np.max(np.abs(an - ag)))
    alpha_mae = float(np.mean(np.abs(an - ag)))
    return {
        "ssim_white": ssim_white,
        "ssim_black": ssim_black,
        "ssim_alpha": ssim_alpha,
        "ssim_min": min(ssim_white, ssim_black, ssim_alpha),
        "alpha_linf": alpha_linf,
        "alpha_mae": alpha_mae,
    }


def cmd_save(args):
    images = find_images(args.images)
    if not images:
        print("Nenhuma imagem em %s" % args.images, file=sys.stderr)
        sys.exit(1)
    src_dir = os.path.join(args.out, "sources")
    os.makedirs(src_dir, exist_ok=True)
    print("Congelando golden de %d imagens em %s" % (len(images), args.out))
    for path in images:
        stem = os.path.splitext(os.path.basename(path))[0]
        shutil.copy2(path, os.path.join(src_dir, os.path.basename(path)))
        with open(path, "rb") as f:
            raw = f.read()
        for suffix, add_shadow in VARIANTS:
            out, _timing, _dt = post_remove_bg(
                args.url, raw, add_shadow, args.timeout
            )
            dst = os.path.join(args.out, "%s.%s.png" % (stem, suffix))
            with open(dst, "wb") as g:
                g.write(out)
            print("  salvo %s (%d bytes)" % (os.path.basename(dst), len(out)))
    print("Golden congelado. NAO commitar imagens grandes — guardar fora do git.")


def cmd_compare(args):
    src_dir = os.path.join(args.golden, "sources")
    sources = find_images(src_dir)
    if not sources:
        print("Sem fontes em %s (rode 'save' antes)" % src_dir, file=sys.stderr)
        sys.exit(1)
    print(
        "Comparando %d fontes x %d variantes contra o golden\n"
        "Limiares: SSIM>=%.3f  alpha_Linf<=%.1f  alpha_MAE<=%.2f\n"
        % (len(sources), len(VARIANTS), args.ssim_min, args.alpha_linf_max, args.alpha_mae_max)
    )
    failures = 0
    checked = 0
    for path in sources:
        stem = os.path.splitext(os.path.basename(path))[0]
        with open(path, "rb") as f:
            raw = f.read()
        for suffix, add_shadow in VARIANTS:
            gold_path = os.path.join(args.golden, "%s.%s.png" % (stem, suffix))
            if not os.path.exists(gold_path):
                print("  [skip] golden ausente: %s" % os.path.basename(gold_path))
                continue
            checked += 1
            out, _timing, _dt = post_remove_bg(args.url, raw, add_shadow, args.timeout)
            m = compare_pair(load_rgba(out), load_rgba(gold_path))
            tag = "%s/%s" % (stem, suffix)
            if "shape_mismatch" in m:
                failures += 1
                print("  [FAIL] %-28s DIMENSAO mudou %s -> %s" % (tag, m["shape_mismatch"][1], m["shape_mismatch"][0]))
                continue
            ok = (
                m["ssim_min"] >= args.ssim_min
                and m["alpha_linf"] <= args.alpha_linf_max
                and m["alpha_mae"] <= args.alpha_mae_max
            )
            if not ok:
                failures += 1
            print(
                "  [%s] %-28s SSIM(w=%.4f b=%.4f a=%.4f) alpha(Linf=%.1f MAE=%.3f)"
                % (
                    "PASS" if ok else "FAIL",
                    tag,
                    m["ssim_white"],
                    m["ssim_black"],
                    m["ssim_alpha"],
                    m["alpha_linf"],
                    m["alpha_mae"],
                )
            )
    print("\n%d/%d comparacoes OK." % (checked - failures, checked))
    if failures:
        print("BLOQUEIO: %d regressao(oes) detectada(s)." % failures)
        sys.exit(2)
    print("Gate de qualidade VERDE.")


def main():
    ap = argparse.ArgumentParser(description="Golden set + gate de qualidade (Fase 0).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("save", help="congela o golden")
    sp.add_argument("--url", default="http://127.0.0.1:8000/remove-bg")
    sp.add_argument("--images", required=True)
    sp.add_argument("--out", required=True)
    sp.add_argument("--timeout", type=float, default=120.0)
    sp.set_defaults(func=cmd_save)

    cp = sub.add_parser("compare", help="compara contra o golden")
    cp.add_argument("--url", default="http://127.0.0.1:8000/remove-bg")
    cp.add_argument("--golden", required=True)
    cp.add_argument("--ssim-min", type=float, default=0.995)
    cp.add_argument("--alpha-linf-max", type=float, default=2.0)
    cp.add_argument("--alpha-mae-max", type=float, default=0.5)
    cp.add_argument("--timeout", type=float, default=120.0)
    cp.set_defaults(func=cmd_compare)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
