#!/bin/bash

echo "🚀 開始啟動 Whisper 轉錄服務..."

echo "📋 檢查依賴..."

echo "🔍 檢查 FFmpeg..."
ffmpeg -version >/dev/null 2>&1 && echo "✅ FFmpeg 可用" || echo "❌ FFmpeg 不可用"

echo "🔍 檢查 Node.js 依賴..."
npm list whisper-node >/dev/null 2>&1 && echo "✅ whisper-node 可用" || echo "❌ whisper-node 不可用"

echo "🔍 檢查 Whisper 模型..."

# 設定非交互模式
export CI=true
export DEBIAN_FRONTEND=noninteractive

if [ ! -d "./models" ]; then
    echo "⚠️ 模型目錄不存在，創建目錄..."
    mkdir -p models
fi

# 檢查模型是否存在且有效（大於 1KB）
if [ ! -f "./models/ggml-base.bin" ] || [ $(stat -f%z "./models/ggml-base.bin" 2>/dev/null || stat -c%s "./models/ggml-base.bin" 2>/dev/null || echo "0") -lt 1000 ]; then
    echo "⚠️ 模型不存在或無效，運行初始化..."
    node init-whisper.js || {
        echo "⚠️ 初始化腳本失敗，使用最後備用方案..."
        curl -L -o models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin || {
            echo "⚠️ 所有下載方法都失敗，應用將嘗試在運行時下載"
        }
    }
else
    echo "✅ Whisper 模型已存在且有效"
fi

echo "🚀 啟動 Node.js 應用..."
exec node src/server.js