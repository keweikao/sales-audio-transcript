#!/opt/venv/bin/python
"""
預載 faster-whisper 繁體中文模型腳本
這個腳本會在應用啟動前預先下載和加載模型，避免首次使用時的延遲
"""

import os
import sys
import logging
from faster_whisper import WhisperModel

# 設定日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def preload_model():
    """
    預載繁體中文優化的 faster-whisper 模型
    """
    try:
        model_name = "small"   # 緊急降級到 small 模型，最小記憶體佔用
        logger.info(f"開始預載模型: {model_name}")
        
        # 建立模型目錄
        model_dir = "/app/models"
        os.makedirs(model_dir, exist_ok=True)
        
        # 下載並載入模型
        model = WhisperModel(
            model_name,
            device="cpu",  # Zeabur 通常使用 CPU
            compute_type="int8",  # 使用 int8 減少記憶體用量
            cpu_threads=1,  # 降到單線程，最小化資源使用
            download_root=model_dir
        )
        
        logger.info("模型預載成功!")
        
        # 測試模型是否正常工作
        logger.info("正在測試模型...")
        
        # 建立一個簡單的測試音頻（靜音）
        import tempfile
        import subprocess
        
        # 使用 ffmpeg 建立 1 秒的靜音測試音頻
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_audio:
            subprocess.run([
                "ffmpeg", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                "-t", "1", "-y", temp_audio.name
            ], capture_output=True, check=True)
            
            # 測試轉錄功能
            segments, info = model.transcribe(
                temp_audio.name,
                language="zh",
                initial_prompt="以下是一段繁體中文語音內容的轉錄："
            )
            
            # 清理測試文件
            os.unlink(temp_audio.name)
        
        logger.info(f"模型測試完成! 檢測到語言: {info.language}")
        logger.info("faster-whisper 繁體中文模型已準備就緒")
        
        return True
        
    except Exception as e:
        logger.error(f"模型預載失敗: {e}")
        return False

if __name__ == "__main__":
    success = preload_model()
    sys.exit(0 if success else 1)