FROM python:3.11-slim

WORKDIR /app

# Libs nativas que rembg/onnxruntime/Pillow precisam em runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Modelo default: isnet-general-use (~1s/img, pico ~1.6GB RAM; borda boa com
# o refino, bem acima do u2net). Trocável no build sem editar código — p/
# máxima qualidade em fundo complexo (custa ~7s + pico ~8.5GB RAM, exige
# servidor com folga de RAM e mem_limit maior no compose):
#   docker build --build-arg REMBG_MODEL=birefnet-general-lite
# O ENV persiste em runtime, então o app.py usa o MESMO modelo pré-baixado.
ARG REMBG_MODEL=isnet-general-use
ENV REMBG_MODEL=${REMBG_MODEL}

# Pré-baixa o modelo no build (~178MB p/ o isnet) pra evitar latência no
# primeiro request em produção (senão a 1ª chamada baixaria e duraria dezenas de s).
RUN python -c "from rembg import new_session; new_session('$REMBG_MODEL')"

COPY app.py .

EXPOSE 8000

# 1 worker é suficiente (modelo é caro pra carregar; mais workers = mais RAM).
# Aumente em produção se a carga justificar.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
