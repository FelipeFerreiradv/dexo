#!/usr/bin/env python3
"""
Varredura de threads do ONNX Runtime (Camada A / A1) — acha o "joelho".

A inferencia do BiRefNet em CPU e' memory-bound: passar do ponto de saturacao de
banda, mais threads intra-op so adicionam contencao (o jitter visto na Fase 0).
Hoje o rembg seta intra_op = inter_op = OMP_NUM_THREADS (=8). Este script mede,
NUM UNICO PROCESSO (sem reiniciar container), o tempo da inferencia para varios
intra_op com execution_mode=SEQUENTIAL e inter_op=1, alem do baseline atual.

Mesmo modelo, mesma saida — so muda config de thread. Depois de achar o melhor
intra_op, ligue no container real (REMBG_ORT_TUNE=true REMBG_INTRA_OP_THREADS=N)
e valide ponta-a-ponta com bench.py + golden.py compare.

Uso (dentro do container bench; rode com a live PARADA ou em baixo trafego p/
nao contaminar com contencao de CPU):
  python /bench/sweep_threads.py --image /images/synthetic/syn_media_cheia_complexo.jpg \
      --iters 5 --warmup 2 --intra 8,6,5,4,3,2
"""

import argparse
import gc
import os
import statistics
from time import perf_counter

import onnxruntime as ort
from PIL import Image
from rembg import new_session, remove
from rembg.sessions import sessions_class


def resolve_class(model):
    for sc in sessions_class:
        if sc.name() == model:
            return sc
    raise SystemExit("classe de sessao nao encontrada p/ %r" % model)


def build_tuned(model, intra, inter):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.intra_op_num_threads = intra
    so.inter_op_num_threads = inter
    return resolve_class(model)(model, so, ["CPUExecutionProvider"])


def pct(values, p):
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (p / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def time_session(sess, img, iters, warmup):
    ts = []
    for i in range(iters + warmup):
        t0 = perf_counter()
        remove(img, session=sess, post_process_mask=False)
        dt = (perf_counter() - t0) * 1000.0
        if i >= warmup:
            ts.append(dt)
    return ts


def report(label, ts):
    print(
        "  %-34s mediana=%8.1f ms   p95=%8.1f   min=%8.1f   max=%8.1f"
        % (label, statistics.median(ts), pct(ts, 95), min(ts), max(ts))
    )


def main():
    ap = argparse.ArgumentParser(description="Varredura de threads ONNX (A1).")
    ap.add_argument("--image", required=True, help="imagem-fonte representativa")
    ap.add_argument("--model", default=os.getenv("REMBG_MODEL", "birefnet-general-lite"))
    ap.add_argument("--iters", type=int, default=5)
    ap.add_argument("--warmup", type=int, default=2)
    ap.add_argument("--intra", default="8,6,5,4,3,2", help="lista de intra_op")
    ap.add_argument("--inter", type=int, default=1, help="inter_op das tunadas")
    args = ap.parse_args()

    img = Image.open(args.image).convert("RGB")
    intra_list = [int(x) for x in args.intra.split(",") if x.strip()]
    print(
        "Sweep de threads | modelo=%s | imagem=%s | %d iters (warmup %d)"
        % (args.model, os.path.basename(args.image), args.iters, args.warmup)
    )
    print("OMP_NUM_THREADS=%s  nproc=%s\n" % (os.getenv("OMP_NUM_THREADS"), os.cpu_count()))

    # Baseline: exatamente o que roda hoje (new_session le OMP_NUM_THREADS).
    base = new_session(args.model)
    report("BASELINE new_session (hoje)", time_session(base, img, args.iters, args.warmup))
    del base
    gc.collect()

    print("\n  --- tunado: execution_mode=SEQUENTIAL, inter_op=%d ---" % args.inter)
    results = []
    for intra in intra_list:
        sess = build_tuned(args.model, intra, args.inter)
        ts = time_session(sess, img, args.iters, args.warmup)
        report("intra_op=%d" % intra, ts)
        results.append((intra, statistics.median(ts)))
        del sess
        gc.collect()

    best = min(results, key=lambda r: r[1])
    print(
        "\nMelhor intra_op = %d (mediana %.1f ms). "
        "Valide ponta-a-ponta: suba o container com\n"
        "  -e REMBG_ORT_TUNE=true -e REMBG_INTRA_OP_THREADS=%d\n"
        "e rode bench.py + golden.py compare (gate SSIM)." % (best[0], best[1], best[0])
    )
    print("\nCole esta saida de volta.")


if __name__ == "__main__":
    main()
