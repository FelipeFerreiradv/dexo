#!/usr/bin/env python3
"""
Harness de benchmark do sidecar rembg (Fase 0 — MEDIR antes de mexer).

Mede latencia do `POST /remove-bg` SEM alterar nada do servico. Le o header
`X-Rembg-Timing` (so existe quando o sidecar roda com REMBG_PROFILE=true) pra
quebrar o tempo por estagio (decode/remove/to_rgba/refine/shadow/encode).

Dois modos, deliberadamente separados (ver README — lote e' medicao de FILA de
1 worker; nenhuma otimizacao de imagem unica move o lote):

  single  1 request por vez (sequencial)  -> SERVICE TIME (mediana + p95)
  batch   concorrencia real do front (3)  -> WALL-CLOCK do lote + p95 por req

Sem dependencias externas: so stdlib (roda dentro do proprio container do
sidecar via `docker exec`). Roda para shadow=False e shadow=True.

Uso (dentro do container bench):
  python /bench/bench.py --url http://127.0.0.1:8000/remove-bg \
      --images /images --iters 12 --warmup 2 --concurrency 3 --batch 6
"""

import argparse
import glob
import os
import statistics
import sys
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from time import perf_counter

IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
# "postprocess" so aparece com REMBG_MASK_POSTPROCESS=true (sidecar >= PR 2);
# o print abaixo lista apenas os estagios presentes no header, entao um
# sidecar antigo continua funcionando com este bench.
STAGE_ORDER = ["decode", "remove", "to_rgba", "postprocess", "refine", "shadow", "encode"]


def find_images(path):
    if os.path.isfile(path):
        return [path]
    out = []
    for ext in IMG_EXTS:
        out.extend(glob.glob(os.path.join(path, "**", "*" + ext), recursive=True))
    return sorted(out)


def encode_multipart(fields, file_field, filename, ctype, data):
    boundary = "----dexobench" + uuid.uuid4().hex
    body = BytesIO()
    for name, val in fields.items():
        body.write(("--" + boundary + "\r\n").encode())
        body.write(
            ('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode()
        )
        body.write((str(val) + "\r\n").encode())
    body.write(("--" + boundary + "\r\n").encode())
    body.write(
        (
            'Content-Disposition: form-data; name="%s"; filename="%s"\r\n'
            % (file_field, filename)
        ).encode()
    )
    body.write(("Content-Type: %s\r\n\r\n" % ctype).encode())
    body.write(data)
    body.write(b"\r\n")
    body.write(("--" + boundary + "--\r\n").encode())
    return boundary, body.getvalue()


def post_remove_bg(url, img_bytes, add_shadow, timeout):
    fields = {"add_shadow": "true"} if add_shadow else {}
    boundary, body = encode_multipart(
        fields, "file", "input.png", "image/png", img_bytes
    )
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
    t0 = perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        out = resp.read()
        timing = resp.headers.get("X-Rembg-Timing", "")
    dt_ms = (perf_counter() - t0) * 1000.0
    return out, timing, dt_ms


def parse_timing(timing):
    """`decode=12.3;remove=6800.1;...` -> {stage: ms}."""
    d = {}
    for part in timing.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            try:
                d[k.strip()] = float(v)
            except ValueError:
                pass
    return d


def pct(values, p):
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (p / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def fmt(x):
    return ("%9.1f" % x) if isinstance(x, float) else ("%9s" % x)


def run_single(url, images, iters, warmup, add_shadow, timeout):
    print(
        "\n=== SINGLE (sequencial) | shadow=%s | %d imagens x %d iters (warmup %d) ==="
        % (add_shadow, len(images), iters, warmup)
    )
    totals = []
    stage_samples = {s: [] for s in STAGE_ORDER}
    bytes_samples = []
    saw_timing = False
    for path in images:
        with open(path, "rb") as f:
            raw = f.read()
        for i in range(iters):
            out, timing, dt = post_remove_bg(url, raw, add_shadow, timeout)
            if i < warmup:
                continue
            totals.append(dt)
            bytes_samples.append(len(out))
            t = parse_timing(timing)
            if t:
                saw_timing = True
                for s in STAGE_ORDER:
                    if s in t:
                        stage_samples[s].append(t[s])

    if not totals:
        print("  (sem amostras — confira --iters > --warmup)")
        return

    if saw_timing:
        print("  estagio        mediana(ms)     p95(ms)")
        for s in STAGE_ORDER:
            vals = stage_samples[s]
            if vals:
                print(
                    "  %-12s  %s  %s"
                    % (s, fmt(statistics.median(vals)), fmt(pct(vals, 95)))
                )
    else:
        print(
            "  [aviso] sem header X-Rembg-Timing — suba o sidecar com "
            "REMBG_PROFILE=true pra ver o breakdown por estagio."
        )

    print(
        "  TOTAL round-trip: mediana=%.1f ms  p95=%.1f ms  min=%.1f  max=%.1f"
        % (
            statistics.median(totals),
            pct(totals, 95),
            min(totals),
            max(totals),
        )
    )
    print(
        "  bytes de saida: mediana=%d  min=%d  max=%d"
        % (
            int(statistics.median(bytes_samples)),
            min(bytes_samples),
            max(bytes_samples),
        )
    )


def run_batch(url, images, batch, concurrency, repeats, add_shadow, timeout):
    print(
        "\n=== BATCH (concorrencia %d = front) | shadow=%s | lote de %d | %d repeticoes ==="
        % (concurrency, add_shadow, batch, repeats)
    )
    print("  (mede a FILA do worker unico — nao o service time isolado)")
    # Monta o lote repetindo as imagens ate atingir `batch`.
    raws = []
    idx = 0
    while len(raws) < batch and images:
        with open(images[idx % len(images)], "rb") as f:
            raws.append(f.read())
        idx += 1

    wall_samples = []
    per_req_samples = []
    for _ in range(repeats):
        results = []
        t0 = perf_counter()
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futs = [
                ex.submit(post_remove_bg, url, raw, add_shadow, timeout)
                for raw in raws
            ]
            for fut in futs:
                _out, _timing, dt = fut.result()
                results.append(dt)
        wall = (perf_counter() - t0) * 1000.0
        wall_samples.append(wall)
        per_req_samples.extend(results)

    print(
        "  WALL-CLOCK do lote (%d imgs): mediana=%.1f ms  p95=%.1f ms"
        % (batch, statistics.median(wall_samples), pct(wall_samples, 95))
    )
    print(
        "  por request (sob fila): mediana=%.1f ms  p95=%.1f ms  max=%.1f ms"
        % (
            statistics.median(per_req_samples),
            pct(per_req_samples, 95),
            max(per_req_samples),
        )
    )


def main():
    ap = argparse.ArgumentParser(description="Benchmark do sidecar rembg (Fase 0).")
    ap.add_argument("--url", default="http://127.0.0.1:8000/remove-bg")
    ap.add_argument("--images", required=True, help="arquivo ou diretorio de imagens")
    ap.add_argument("--iters", type=int, default=12, help="iters por imagem (single)")
    ap.add_argument("--warmup", type=int, default=2, help="iters descartadas (single)")
    ap.add_argument("--concurrency", type=int, default=3, help="= UPLOAD_CONCURRENCY")
    ap.add_argument("--batch", type=int, default=6, help="imagens por lote (batch)")
    ap.add_argument("--repeats", type=int, default=3, help="repeticoes do lote")
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument(
        "--shadow",
        choices=["both", "off", "on"],
        default="both",
        help="rodar sem sombra, com sombra, ou ambos (default)",
    )
    ap.add_argument("--skip-single", action="store_true")
    ap.add_argument("--skip-batch", action="store_true")
    args = ap.parse_args()

    images = find_images(args.images)
    if not images:
        print("Nenhuma imagem encontrada em %s" % args.images, file=sys.stderr)
        sys.exit(1)
    print("Imagens (%d): %s" % (len(images), ", ".join(os.path.basename(p) for p in images)))
    print("Sidecar: %s" % args.url)

    shadows = {"both": [False, True], "off": [False], "on": [True]}[args.shadow]

    for add_shadow in shadows:
        if not args.skip_single:
            run_single(args.url, images, args.iters, args.warmup, add_shadow, args.timeout)
        if not args.skip_batch:
            run_batch(
                args.url,
                images,
                args.batch,
                args.concurrency,
                args.repeats,
                add_shadow,
                args.timeout,
            )

    print("\nPronto. Cole TODA essa saida de volta pro diagnostico da Fase 0.")


if __name__ == "__main__":
    main()
