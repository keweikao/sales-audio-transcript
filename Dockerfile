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

# 更新 pip 並安裝基本套件
RUN /opt/venv/bin/pip install --upgrade pip setuptools wheel

# 安裝相容的 NumPy 版本以避免 PyTorch 警告
RUN /opt/venv/bin/pip install --no-cache-dir "numpy>=1.21.0,<1.25.0"

# 先安裝 CPU 版本的 PyTorch （faster-whisper 的依賴）
# 使用更穩定的版本組合
RUN /opt/venv/bin/pip install --no-cache-dir \
    torch==2.0.1+cpu --index-url https://download.pytorch.org/whl/cpu
RUN /opt/venv/bin/pip install --no-cache-dir \
    torchaudio==2.0.2+cpu --index-url https://download.pytorch.org/whl/cpu

# 安裝其他相容性套件
RUN /opt/venv/bin/pip install --no-cache-dir \
    "scipy>=1.9.0,<1.12.0" \
    "librosa>=0.9.0,<0.11.0"

# 安裝 faster-whisper
RUN /opt/venv/bin/pip install --no-cache-dir faster-whisper

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
# 設定 Python 警告過濾
ENV PYTHONWARNINGS="ignore::UserWarning"
ENV TF_CPP_MIN_LOG_LEVEL=2
# 記憶體限制和優化 (移除不被允許的 --expose-gc)
ENV NODE_OPTIONS="--max-old-space-size=2048 --optimize-for-size"
ENV MALLOC_TRIM_THRESHOLD_=100000
ENV MALLOC_MMAP_THRESHOLD_=131072

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