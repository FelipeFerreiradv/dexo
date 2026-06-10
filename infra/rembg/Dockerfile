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

# 1 worker é suficiente (modelo é caro pra carregar; mais workers = mais RAM).
# Aumente em produção se a carga justificar.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
