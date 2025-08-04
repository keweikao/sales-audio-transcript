# 使用 Python 基礎映像以支援 faster-whisper
FROM python:3.10-slim

# 安裝 Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# 安裝必要的系統套件
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 安裝 faster-whisper 和相關 Python 套件
RUN pip install --no-cache-dir \
    faster-whisper==1.0.3 \
    torch==2.1.0 \
    torchaudio==2.1.0 \
    --index-url https://download.pytorch.org/whl/cpu

# 驗證 FFmpeg 和 faster-whisper 安裝
RUN ffmpeg -version && python3 -c "from faster_whisper import WhisperModel; print('faster-whisper installed successfully')"

# 設定工作目錄
WORKDIR /app

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝 Node.js 依賴
RUN npm install --only=production

# 複製應用程式代碼
COPY . .

# 創建必要的目錄
RUN mkdir -p /app/data /app/logs /app/models /app/scripts

# 複製模型預載腳本
COPY scripts/preload-model.py /app/scripts/
RUN chmod +x /app/scripts/preload-model.py

# 設定環境變數
ENV NODE_ENV=production
ENV PORT=3000
ENV PYTHONPATH=/app
ENV MODEL_CACHE_DIR=/app/models

# 暴露端口
EXPOSE 3000

# 健康檢查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# 創建啟動腳本
RUN echo '#!/bin/bash\n\
echo "預載 faster-whisper 模型..."\n\
python3 /app/scripts/preload-model.py\n\
if [ $? -eq 0 ]; then\n\
  echo "模型預載成功，啟動應用..."\n\
  exec npm start\n\
else\n\
  echo "模型預載失敗，但仍嘗試啟動應用..."\n\
  exec npm start\n\
fi' > /app/start.sh && chmod +x /app/start.sh

# 啟動應用程式
CMD ["/app/start.sh"]