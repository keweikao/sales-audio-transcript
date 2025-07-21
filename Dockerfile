# 使用 Ubuntu 基礎映像獲得完整的編解碼器支援
FROM node:18-bullseye

# 更新套件列表並安裝完整的 FFmpeg 支援和 Whisper
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libavcodec-extra \
    python3 \
    python3-pip \
    build-essential \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# 安裝 OpenAI Whisper
RUN pip3 install --no-cache-dir openai-whisper

# 預下載 Whisper large 模型（可選，但建議）
RUN python3 -c "import whisper; whisper.load_model('large')"

# 驗證 FFmpeg 安裝和編解碼器支援
RUN ffmpeg -codecs 2>/dev/null | grep mp3 && echo "✅ MP3 codec available" || echo "❌ MP3 codec not found"
RUN ffmpeg -encoders 2>/dev/null | grep mp3 && echo "✅ MP3 encoder available" || echo "❌ MP3 encoder not found"

# 設定工作目錄
WORKDIR /app

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝 Node.js 依賴
RUN npm install --only=production

# 複製應用程式代碼
COPY . .

# 創建必要的目錄
RUN mkdir -p /app/data /app/logs

# 設定環境變數
ENV NODE_ENV=production
ENV PORT=3000

# 暴露端口
EXPOSE 3000

# 健康檢查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# 啟動應用程式
CMD ["npm", "start"]