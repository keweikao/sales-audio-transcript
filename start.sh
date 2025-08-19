#!/bin/bash

echo "🚀 開始啟動 Whisper 轉錄服務..."

# 檢查 Python 和 Whisper
echo "📋 檢查依賴..."
python3 --version
pip3 --version

echo "🔍 檢查 Whisper 安裝..."
python3 -c "import whisper; print('✅ Whisper 可用')" || {
    echo "❌ Whisper 不可用，嘗試重新安裝..."
    pip3 install --no-cache-dir openai-whisper
}

echo "🔍 檢查 FFmpeg..."
ffmpeg -version >/dev/null 2>&1 && echo "✅ FFmpeg 可用" || echo "❌ FFmpeg 不可用"

echo "🔍 檢查 Node.js 依賴..."
npm list node-whisper >/dev/null 2>&1 && echo "✅ node-whisper 可用" || echo "❌ node-whisper 不可用"

echo "🚀 啟動 Node.js 應用..."
exec node src/server.js