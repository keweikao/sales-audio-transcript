FROM node:18-alpine

# Install Python, pip, ffmpeg, and all necessary build tools in a single step
RUN apk add --no-cache python3 py3-pip ffmpeg

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

# 安裝 OpenAI whisper (使用標準版本，兼容性更好)
RUN pip3 install --no-cache-dir --break-system-packages openai-whisper

# 預下載 whisper 模型
RUN python3 -c "import whisper; whisper.load_model('base')" || echo "Model will be downloaded at runtime"

# 設定啟動腳本權限
RUN chmod +x start.sh

# 設定環境變數
ENV NODE_ENV=production
ENV PORT=3000

# 暴露端口
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
