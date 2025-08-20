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
  
  // 設定非交互式環境
  process.env.CI = 'true';
  process.env.DEBIAN_FRONTEND = 'noninteractive';
  
  const modelPath = path.join(__dirname, 'models', 'ggml-base.bin');
  const modelsDir = path.dirname(modelPath);
  
  // 確保模型目錄存在
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }
  
  // 檢查模型是否已存在且有效
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1000) {
    console.log('✅ Whisper 模型已存在');
    return;
  }
  
  const downloadUrls = [
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    'https://openaipublic.azureedge.net/whisper/models/base.bin',
    'https://github.com/ggerganov/whisper.cpp/raw/master/models/ggml-base.bin'
  ];
  
  // 嘗試從多個來源下載模型
  for (let i = 0; i < downloadUrls.length; i++) {
    try {
      const url = downloadUrls[i];
      console.log(`📥 嘗試下載模型 (來源 ${i + 1}/${downloadUrls.length}): ${url}`);
      
      execSync(`curl -L --max-time 300 --retry 3 -o models/ggml-base.bin "${url}"`, {
        stdio: 'inherit',
        timeout: 300000 // 5 分鐘超時
      });
      
      // 驗證下載的模型
      if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1000) {
        console.log('✅ 模型下載成功');
        return;
      } else {
        console.log('⚠️ 下載的模型檔案無效，嘗試下一個來源...');
      }
    } catch (error) {
      console.log(`⚠️ 來源 ${i + 1} 下載失敗: ${error.message}`);
      if (i < downloadUrls.length - 1) {
        console.log('🔄 嘗試下一個下載來源...');
      }
    }
  }
  
  // 如果所有下載都失敗，記錄並繼續
  console.log('⚠️ 所有模型下載來源都失敗，將在應用啟動時重試');
  console.log('📄 創建佔位符以避免後續錯誤...');
  fs.writeFileSync(modelPath, '# Placeholder - model will be downloaded at runtime');
}

// 如果直接執行此檔案
if (require.main === module) {
  initializeWhisperNode().catch(error => {
    console.error(`初始化失敗: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { initializeWhisperNode };