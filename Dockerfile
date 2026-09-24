FROM node:20-slim

# Install system dependencies (ffmpeg, python3, pip, curl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp latest
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Buat non-root user (Hugging Face Spaces default UID 1000)
RUN useradd -m -u 1000 appuser

WORKDIR /app

# Copy dependency files
COPY package*.json ./
RUN npm install --production

# Copy application files
COPY . .

# Set hak akses untuk appuser
RUN chown -R appuser:appuser /app

USER appuser

# Hugging Face Spaces port
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]
