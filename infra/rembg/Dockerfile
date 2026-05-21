FROM python:3.11-slim

WORKDIR /app

# Libs nativas que rembg/onnxruntime/Pillow precisam em runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pré-baixa o modelo U2Net no build (~170MB) para evitar latência no
# primeiro request em produção. Sem isso, a primeira chamada baixaria
# o modelo e duraria 30-60s.
RUN python -c "from rembg import new_session; new_session('u2net')"

COPY app.py .

EXPOSE 8000

# 1 worker é suficiente (modelo é caro pra carregar; mais workers = mais RAM).
# Aumente em produção se a carga justificar.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
