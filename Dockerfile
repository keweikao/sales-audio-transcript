FROM node:18-alpine

# Install Python, pip, ffmpeg, and necessary build tools in a single step
RUN apk add --no-cache --virtual .build-deps g++ make cmake && \
    apk add --no-cache python3 py3-pip ffmpeg

# Install torch and torchaudio first from the specific index URL.
# This is a more robust way to ensure correct versions are found without conflict.
RUN pip install --no-cache-dir --break-system-packages "torch==2.6.0+cpu" "torchaudio" --extra-index-url https://download.pytorch.org/whl/cpu

# Install faster-whisper, which will use the already-installed torch.
RUN pip install --no-cache-dir --break-system-packages "faster-whisper==0.10.0"

# Set up working directory and create models directory
WORKDIR /app
RUN mkdir -p /app/models

# Download the whisper model
# You can change 'large-v3' to other models like 'medium', 'small', 'base'
ARG WHISPER_MODEL=large-v3
ENV WHISPER_MODEL_NAME=${WHISPER_MODEL}
# The download_root will be relative to the WORKDIR
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL_NAME}', device='cpu', download_root='models')"

# Set environment variables for model path
ENV WHISPER_MODELS_DIR=/app/models

# Clean up build dependencies to keep the image size small
RUN apk del .build-deps

# Copy package files and install Node.js dependencies
COPY package*.json ./
RUN npm install --only=production

# Copy the rest of the application code
COPY . .

# Expose port and set up healthcheck
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
