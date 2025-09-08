#!/usr/bin/env node

/**
 * 健康檢查腳本
 * 用於檢查應用程式的各個組件是否正常運作
 */

const http = require('http');
const { execSync } = require('child_process');

async function healthCheck() {
  console.log('🔍 開始健康檢查...');
  
  const checks = [
    checkNodeModules,
    checkWhisperNode,
    checkFFmpeg,
    checkEnvironmentVariables,
    checkServer
  ];
  
  let allPassed = true;
  
  for (const check of checks) {
    try {
      await check();
    } catch (error) {
      console.error(`❌ ${error.message}`);
      allPassed = false;
    }
  }
  
  if (allPassed) {
    console.log('✅ 所有健康檢查通過！');
    process.exit(0);
  } else {
    console.log('❌ 健康檢查失敗');
    process.exit(1);
  }
}

function checkNodeModules() {
  console.log('🔍 檢查 Node.js 依賴...');
  
  const requiredModules = [
    'express',
    'whisper-node',
    'googleapis',
    'bull',
    'ioredis',
    'fluent-ffmpeg',
    'winston'
  ];
  
  for (const module of requiredModules) {
    try {
      require(module);
      console.log(`  ✅ ${module}`);
    } catch (error) {
      throw new Error(`缺少依賴: ${module}`);
    }
  }
}

function checkWhisperNode() {
  console.log('🔍 檢查 whisper-node...');
  
  try {
    const whisper = require('whisper-node');
    console.log('  ✅ whisper-node 載入成功');
  } catch (error) {
    throw new Error(`whisper-node 載入失敗: ${error.message}`);
  }
}

function checkFFmpeg() {
  console.log('🔍 檢查 FFmpeg...');
  
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
    console.log('  ✅ FFmpeg 可用');
  } catch (error) {
    throw new Error('FFmpeg 不可用');
  }
}

function checkEnvironmentVariables() {
  console.log('🔍 檢查環境變數...');
  
  const requiredEnvVars = [
    'GOOGLE_SERVICE_ACCOUNT_KEY',
    'GOOGLE_SPREADSHEET_ID'
  ];
  
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`缺少環境變數: ${envVar}`);
    }
    console.log(`  ✅ ${envVar}`);
  }
  
  // 檢查 Google 服務帳戶金鑰格式
  try {
    const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    if (!key.private_key || !key.client_email) {
      throw new Error('Google 服務帳戶金鑰格式不正確');
    }
    console.log('  ✅ Google 服務帳戶金鑰格式正確');
  } catch (error) {
    throw new Error(`Google 服務帳戶金鑰解析失敗: ${error.message}`);
  }
}

function checkServer() {
  return new Promise((resolve, reject) => {
    console.log('🔍 檢查伺服器連接...');
    
    const port = process.env.PORT || 3000;
    
    const req = http.request({
      hostname: 'localhost',
      port: port,
      path: '/health',
      method: 'GET',
      timeout: 5000
    }, (res) => {
      if (res.statusCode === 200) {
        console.log('  ✅ 伺服器回應正常');
        resolve();
      } else {
        reject(new Error(`伺服器回應異常: ${res.statusCode}`));
      }
    });
    
    req.on('error', (error) => {
      // 如果伺服器還沒啟動，這是正常的
      if (error.code === 'ECONNREFUSED') {
        console.log('  ⚠️ 伺服器尚未啟動 (正常)');
        resolve();
      } else {
        reject(new Error(`伺服器連接失敗: ${error.message}`));
      }
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('伺服器連接超時'));
    });
    
    req.end();
  });
}

// 如果直接執行此檔案
if (require.main === module) {
  healthCheck();
}

module.exports = { healthCheck };