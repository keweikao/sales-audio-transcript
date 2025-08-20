# --- Stage 1: Build Python environment and download model ---
FROM python:3.10-slim as python-builder

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install faster-whisper and its dependencies
# Using ctranslate2 with CPU support
RUN pip install --no-cache-dir "faster-whisper==0.10.0" "torch==2.1.2" "torchaudio==2.1.2" --extra-index-url https://download.pytorch.org/whl/cpu

# Download the whisper model
# You can change 'large-v3' to other models like 'medium', 'small', 'base'
ARG WHISPER_MODEL=large-v3
ENV WHISPER_MODEL_NAME=${WHISPER_MODEL}
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL_NAME}', device='cpu', download_root='/app/models')"

# --- Stage 2: Final Node.js application ---
FROM node:18-alpine

# Copy Python and model from the builder stage
COPY --from=python-builder /usr/local/lib/python3.10/site-packages/ /usr/local/lib/python3.10/site-packages/
COPY --from=python-builder /usr/local/bin/ /usr/local/bin/
COPY --from=python-builder /app/models /app/models

# Install system dependencies for Node.js
RUN apk add --no-cache \
    ffmpeg \
    python3

# Set environment variables for model path
ENV WHISPER_MODELS_DIR=/app/models

# Set up working directory
WORKDIR /app

# Copy package files and install Node.js dependencies
COPY package*.json .
RUN npm install --only=production

# Copy the rest of the application code
COPY . .

# Expose port and set up healthcheck
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
