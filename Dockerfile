# 使用 Node.js 基礎映像
FROM node:18-bullseye-slim

# 安裝必要套件
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 驗證 FFmpeg 安裝
RUN ffmpeg -version

# 設定工作目錄
WORKDIR /app

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝 Node.js 依賴
RUN npm install --only=production

# 創建模型目錄並嘗試下載 whisper-node 模型
RUN mkdir -p models && \
    (echo "y" | npx whisper-node download || \
     curl -L -o models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin || \
     echo "Model download will be handled at runtime") && \
    echo "Model preparation completed"

# 複製應用程式代碼
COPY . .

# 設定啟動腳本權限
RUN chmod +x start.sh

# 創建必要的目錄
RUN mkdir -p /app/data /app/logs /app/models

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