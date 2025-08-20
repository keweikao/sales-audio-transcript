#!/usr/bin/env python3
"""
OpenAI Whisper 轉錄服務
使用官方 OpenAI whisper 進行音檔轉錄
"""

import sys
import json
import whisper
import argparse
import warnings
from pathlib import Path

# 抑制警告訊息
warnings.filterwarnings("ignore")

def transcribe_audio(audio_path, model_name="base", language="zh"):
    """
    使用 OpenAI Whisper 轉錄音檔
    
    Args:
        audio_path (str): 音檔路徑
        model_name (str): 模型名稱 (tiny, base, small, medium, large)
        language (str): 語言代碼
    
    Returns:
        dict: 轉錄結果
    """
    try:
        # 檢查檔案是否存在
        if not Path(audio_path).exists():
            raise FileNotFoundError(f"音檔不存在: {audio_path}")
        
        # 載入模型
        print(f"正在載入 Whisper 模型: {model_name}", file=sys.stderr)
        model = whisper.load_model(model_name)
        
        # 轉錄選項
        options = {
            "language": language,
            "fp16": False,  # 避免在 CPU 上的潛在問題
            "verbose": False
        }
        
        # 執行轉錄
        print(f"開始轉錄: {audio_path}", file=sys.stderr)
        result = model.transcribe(audio_path, **options)
        
        # 計算品質指標
        text = result["text"].strip()
        segments = result.get("segments", [])
        
        # 計算平均信心度
        avg_confidence = 0.0
        if segments:
            confidences = []
            for segment in segments:
                # Whisper segments 可能沒有 confidence，使用 no_speech_prob 反推
                if "no_speech_prob" in segment:
                    confidence = 1.0 - segment["no_speech_prob"]
                else:
                    confidence = 0.8  # 預設值
                confidences.append(confidence)
            avg_confidence = sum(confidences) / len(confidences)
        else:
            avg_confidence = 0.8 if text else 0.0
        
        # 檢查中文字元比例
        chinese_chars = sum(1 for char in text if '\u4e00' <= char <= '\u9fff')
        chinese_ratio = chinese_chars / len(text) if text else 0
        
        # 計算品質分數
        quality_score = min(100, max(0, 
            avg_confidence * 60 +  # 信心度佔 60%
            (chinese_ratio * 30) +  # 中文比例佔 30%
            (min(len(text) / 10, 10))  # 長度bonus佔 10%
        ))
        
        return {
            "success": True,
            "text": text,
            "language": result.get("language", language),
            "duration": len(segments) * 30 if segments else 0,  # 估算
            "segments_count": len(segments),
            "quality": {
                "score": round(quality_score, 2),
                "confidence": round(avg_confidence, 3),
                "chinese_ratio": round(chinese_ratio, 3)
            }
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "text": "",
            "quality": {
                "score": 0,
                "confidence": 0.0,
                "chinese_ratio": 0.0
            }
        }

def main():
    parser = argparse.ArgumentParser(description="OpenAI Whisper 音檔轉錄")
    parser.add_argument("audio_path", help="音檔路徑")
    parser.add_argument("--model", default="base", choices=["tiny", "base", "small", "medium", "large"], 
                       help="Whisper 模型大小")
    parser.add_argument("--language", default="zh", help="語言代碼 (zh, en, etc.)")
    parser.add_argument("--output-json", action="store_true", help="輸出 JSON 格式")
    
    args = parser.parse_args()
    
    # 執行轉錄
    result = transcribe_audio(args.audio_path, args.model, args.language)
    
    if args.output_json:
        # 輸出 JSON 格式（供 Node.js 解析）
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        # 輸出純文字（向後兼容）
        if result["success"]:
            print(result["text"])
        else:
            print(f"轉錄失敗: {result['error']}", file=sys.stderr)
            sys.exit(1)

if __name__ == "__main__":
    main()