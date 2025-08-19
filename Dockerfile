# 使用 Ubuntu 基礎映像以更好支援 Python 套件
FROM node:18-bullseye-slim

# 安裝必要套件
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 安裝 OpenAI Whisper (使用較小的依賴)
RUN pip3 install --no-cache-dir --upgrade pip \
    && pip3 install --no-cache-dir openai-whisper \
    && python3 -c "import whisper; print('Whisper 安裝成功')"

# 驗證 FFmpeg 安裝
RUN ffmpeg -version

# 設定工作目錄
WORKDIR /app

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝 Node.js 依賴
RUN npm install --only=production

# 複製應用程式代碼
COPY . .

# 設定啟動腳本權限
RUN chmod +x start.sh

# 創建必要的目錄
RUN mkdir -p /app/data /app/logs

# 設定環境變數
ENV NODE_ENV=production
ENV PORT=3000

# 暴露端口
EXPOSE 3000

# 健康檢查 (增加啟動時間)
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# 啟動應用程式
CMD ["./start.sh"]