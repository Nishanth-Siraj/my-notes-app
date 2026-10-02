FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Hosts set PORT (Render: 10000, Hugging Face Spaces: 7860, Koyeb: 8000).
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
