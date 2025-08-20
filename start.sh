#!/bin/bash

echo "🚀 開始啟動 Whisper 轉錄服務..."

echo "📋 檢查依賴..."

echo "🔍 檢查 FFmpeg..."
ffmpeg -version >/dev/null 2>&1 && echo "✅ FFmpeg 可用" || echo "❌ FFmpeg 不可用"

echo "🔍 檢查 Node.js 依賴..."
npm list whisper-node >/dev/null 2>&1 && echo "✅ whisper-node 可用" || echo "❌ whisper-node 不可用"

echo "🔍 檢查 Whisper 模型..."
if [ ! -d "./models" ]; then
    echo "⚠️ 模型目錄不存在，創建目錄..."
    mkdir -p models
fi

# 檢查是否有任何 whisper 模型檔案
if [ ! -f "./models/"*".bin" ]; then
    echo "⚠️ 模型不存在，嘗試下載..."
    echo "y" | npx whisper-node download 2>/dev/null || {
        echo "⚠️ 使用備用下載方式..."
        curl -L -o models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin || {
            echo "⚠️ 下載失敗，模型將在runtime時下載"
        }
    }
else
    echo "✅ Whisper 模型已存在"
fi

echo "🚀 啟動 Node.js 應用..."
exec node src/server.js