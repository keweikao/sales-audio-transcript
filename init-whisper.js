#!/usr/bin/env node

/**
 * whisper-node 初始化腳本
 * 在非交互模式下初始化 whisper-node
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function initializeWhisperNode() {
  console.log('🔧 初始化 whisper-node...');
  
  const modelPath = path.join(__dirname, 'models', 'ggml-base.bin');
  const modelsDir = path.dirname(modelPath);
  
  // 確保模型目錄存在
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }
  
  // 檢查模型是否已存在
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1000) {
    console.log('✅ Whisper 模型已存在');
    return;
  }
  
  try {
    // 方法 1: 直接下載模型
    console.log('📥 下載 whisper 模型...');
    execSync('curl -L -o models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', {
      stdio: 'inherit',
      timeout: 300000 // 5 分鐘超時
    });
    
    if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1000) {
      console.log('✅ 模型下載成功');
      return;
    }
  } catch (error) {
    console.log('⚠️ 直接下載失敗，嘗試編譯 whisper.cpp...');
  }
  
  try {
    // 方法 2: 編譯 whisper.cpp
    const whisperNodePath = path.join(__dirname, 'node_modules', 'whisper-node');
    
    if (fs.existsSync(whisperNodePath)) {
      process.chdir(whisperNodePath);
      
      // 檢查是否有 cpp 目錄
      const cppPath = path.join(whisperNodePath, 'cpp');
      if (fs.existsSync(cppPath)) {
        process.chdir(cppPath);
        console.log('🔨 編譯 whisper.cpp...');
        execSync('make -j$(nproc)', { stdio: 'inherit' });
      }
      
      // 回到原始目錄
      process.chdir(__dirname);
      
      // 嘗試使用編譯後的版本下載模型
      const whisper = require('whisper-node');
      console.log('📥 使用 whisper-node 下載模型...');
      
      // 非交互式下載
      process.env.CI = 'true';
      await whisper.downloadModel('base');
      
      console.log('✅ whisper-node 初始化完成');
    }
  } catch (error) {
    console.log(`⚠️ whisper-node 初始化失敗: ${error.message}`);
    
    // 最後的備用方案 - 創建一個小的佔位符檔案
    console.log('📄 創建模型佔位符...');
    fs.writeFileSync(modelPath, 'placeholder');
    console.log('⚠️ 使用佔位符模型，可能需要在運行時重新下載');
  }
}

// 如果直接執行此檔案
if (require.main === module) {
  initializeWhisperNode().catch(error => {
    console.error(`初始化失敗: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { initializeWhisperNode };