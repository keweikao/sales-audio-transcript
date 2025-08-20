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
npm list whisper-node >/dev/null 2>&1 && echo "✅ whisper-node 可用" || echo "❌ whisper-node 不可用"

echo "🔍 檢查 Whisper 模型..."
if [ ! -d "./models" ]; then
    echo "⚠️ 模型目錄不存在，下載 base 模型..."
    npx whisper-node download
else
    echo "✅ Whisper 模型已存在"
fi

echo "🚀 啟動 Node.js 應用..."
exec node src/server.js