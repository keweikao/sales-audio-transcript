FROM node:18-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    wget \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set up working directory and create models directory
WORKDIR /app
RUN mkdir -p /app/models /app/data /app/logs

# Copy package files and install Node.js dependencies
COPY package*.json ./ 
RUN npm install --only=production

# Copy the rest of the application code
COPY . .

# 設定非交互模式環境變數
ENV DEBIAN_FRONTEND=noninteractive
ENV CI=true

# 建立 Python 虛擬環境並安裝 OpenAI whisper
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir openai-whisper

# 預下載 whisper 模型
RUN python3 -c "import whisper; whisper.load_model('base')" || echo "Model will be downloaded at runtime"

# 設定啟動腳本權限
RUN chmod +x start.sh

# 設定環境變數
ENV NODE_ENV=production
ENV PORT=3000

# 暴露端口
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=30s --start-period=120s --retries=5 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
