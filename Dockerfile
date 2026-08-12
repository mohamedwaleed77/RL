# Stage 1: Build React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ .
RUN npm run build

# Stage 2: Build Python dependencies (Alpine)
FROM python:3.11-alpine AS python-builder
WORKDIR /app/backend

# Build tools only needed here in case any dep lacks a musllinux wheel
# and pip has to compile from sdist. Nothing here ships to the final image.
RUN apk add --no-cache --virtual .build-deps gcc musl-dev python3-dev

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    pip uninstall -y pip setuptools wheel || true

# Drop build tools from this stage (irrelevant once /opt/venv is copied out,
# but keeps this stage itself lean if it's ever cached/reused)
RUN apk del .build-deps

# Trim bytecode/caches
RUN find /opt/venv -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/venv -type f -name "*.pyc" -delete

# Stage 3: Final minimal runtime image (Alpine)
FROM python:3.11-alpine
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH"

# numpy's OpenBLAS backend needs libgomp (OpenMP) at runtime on Alpine —
# without this you'll get an ImportError on `import numpy` inside the container
RUN apk add --no-cache libgomp

COPY --from=python-builder /opt/venv /opt/venv
COPY --from=frontend-builder /app/frontend/build /app/static_build
COPY backend/ /app/

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
