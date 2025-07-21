# 使用輕量化 Alpine 映像以加快構建
FROM node:18-alpine

# 安裝必要套件 (移除 Whisper 相關，因為直接使用 OpenAI API)
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    curl \
    && rm -rf /var/cache/apk/*

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