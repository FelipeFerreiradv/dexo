FROM python:3.11-slim

WORKDIR /app

# Libs nativas que rembg/onnxruntime/Pillow precisam em runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Modelo default: birefnet-general-lite (melhor borda + fundo complexo; pico
# ~8.5GB RAM em CPU — requer servidor com folga, ex. KVM8/32GB). Trocável no
# build sem editar código p/ a variante leve (~1.6GB / ~1s):
#   docker build --build-arg REMBG_MODEL=isnet-general-use
# O ENV persiste em runtime, então o app.py usa o MESMO modelo pré-baixado.
ARG REMBG_MODEL=birefnet-general-lite
ENV REMBG_MODEL=${REMBG_MODEL}

# Pré-baixa o modelo no build (~224MB p/ o birefnet-lite) pra evitar latência
# no primeiro request em produção (senão a 1ª chamada baixaria e duraria dezenas de s).
RUN python -c "from rembg import new_session; new_session('$REMBG_MODEL')"

COPY app.py .

EXPOSE 8000

# Workers configuráveis. Em CPU o birefnet é LIMITADO POR BANDA DE MEMÓRIA
# (4 núcleos ~= 8, e +workers não acelerou o lote nos testes), então o default
# é 1 worker — imagem única mais rápida (usa todos os vCPUs) e menos RAM. A
# infra multi-worker fica disponível p/ tunar (REMBG_WORKERS x OMP_NUM_THREADS
# ~= vCPUs) caso o host tenha banda de memória sobrando. Velocidade percebida
# no lote vem do upload progressivo no front. 'exec' faz o uvicorn virar PID 1.
ENV REMBG_WORKERS=1
ENV OMP_NUM_THREADS=8
CMD ["/bin/sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port 8000 --workers ${REMBG_WORKERS:-1}"]
