# 使用 Node.js 基礎映像並添加 Python 支援
FROM node:18-slim

# 安裝 Python 和系統依賴
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    python3-venv \
    ffmpeg \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 建立 Python 符號連結
RUN ln -s /usr/bin/python3 /usr/bin/python

# 創建虛擬環境並安裝 Python 套件
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# 在虛擬環境中安裝 faster-whisper 和相關套件
RUN /opt/venv/bin/pip install --no-cache-dir \
    faster-whisper \
    torch --index-url https://download.pytorch.org/whl/cpu \
    torchaudio --index-url https://download.pytorch.org/whl/cpu

# 驗證安裝
RUN node --version && npm --version \
    && python3 --version && /opt/venv/bin/pip --version \
    && ffmpeg -version \
    && /opt/venv/bin/python -c "from faster_whisper import WhisperModel; print('faster-whisper installed successfully')"

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
set -e\n\
export PATH="/opt/venv/bin:$PATH"\n\
echo "🚀 啟動 faster-whisper 繁體中文轉錄服務..."\n\
echo "🔍 檢查環境..."\n\
node --version\n\
npm --version\n\
python --version\n\
echo "🤖 預載 faster-whisper 模型..."\n\
timeout 300 python /app/scripts/preload-model.py || echo "⚠️ 模型預載超時或失敗，繼續啟動服務"\n\
echo "🎉 啟動 Node.js 應用..."\n\
exec npm start' > /app/start.sh && chmod +x /app/start.sh

# 啟動應用程式
CMD ["/app/start.sh"]