FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ .
RUN npm run build

FROM python:3.11-slim AS python-builder
WORKDIR /app/backend

COPY backend/requirements.txt .

RUN pip install --no-cache-dir --target=/install torch --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir --target=/install -r requirements.txt

FROM python:3.11-slim
WORKDIR /app

COPY --from=python-builder /install /usr/local/lib/python3.11/site-packages

COPY --from=frontend-builder /app/frontend/build /app/static_build

COPY backend/ /app/

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
