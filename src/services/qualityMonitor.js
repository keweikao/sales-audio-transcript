const winston = require('winston');
const fs = require('fs');
const path = require('path');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// 品質監控配置
const QUALITY_THRESHOLDS = {
  EXCELLENT: 90,
  GOOD: 75,
  ACCEPTABLE: 60,
  POOR: 40,
  FAIL: 25
};

// 建議降級到 OpenAI API 的條件
const FALLBACK_CONDITIONS = {
  qualityScore: 60,        // 品質分數低於60
  confidenceScore: 0.6,    // 信心度低於0.6
  repetitionRatio: 0.4,    // 重複內容超過40%
  chineseRatio: 0.5,       // 中文字元少於50%
  consecutiveFailures: 3   // 連續失敗3次
};

class QualityMonitor {
  constructor() {
    this.stats = {
      totalTranscriptions: 0,
      successfulTranscriptions: 0,
      failedTranscriptions: 0,
      averageQuality: 0,
      averageConfidence: 0,
      consecutiveFailures: 0,
      qualityHistory: [],
      lastFailureTime: null
    };
    
    this.loadStats();
  }

  /**
   * 記錄轉錄結果
   */
  recordTranscription(result) {
    this.stats.totalTranscriptions++;
    
    if (result.success) {
      this.stats.successfulTranscriptions++;
      this.stats.consecutiveFailures = 0;
      
      // 更新品質統計
      const quality = result.quality;
      this.stats.qualityHistory.push({
        timestamp: new Date(),
        score: quality.score,
        confidence: quality.confidence,
        caseId: result.caseId
      });
      
      // 保持最近100次記錄
      if (this.stats.qualityHistory.length > 100) {
        this.stats.qualityHistory.shift();
      }
      
      // 更新平均值
      this.updateAverages();
      
      logger.info(`轉錄成功記錄 - Case ID: ${result.caseId}, 品質: ${quality.score}/100`);
      
    } else {
      this.stats.failedTranscriptions++;
      this.stats.consecutiveFailures++;
      this.stats.lastFailureTime = new Date();
      
      logger.error(`轉錄失敗記錄 - Case ID: ${result.caseId}, 錯誤: ${result.error}`);
    }
    
    this.saveStats();
  }

  /**
   * 更新平均值
   */
  updateAverages() {
    if (this.stats.qualityHistory.length === 0) return;
    
    const recent = this.stats.qualityHistory.slice(-20); // 最近20次
    
    this.stats.averageQuality = recent.reduce((sum, item) => sum + item.score, 0) / recent.length;
    this.stats.averageConfidence = recent.reduce((sum, item) => sum + item.confidence, 0) / recent.length;
  }

  /**
   * 檢查是否應該降級到 OpenAI API
   */
  shouldFallbackToOpenAI(quality) {
    const conditions = FALLBACK_CONDITIONS;
    const reasons = [];
    
    // 檢查品質分數
    if (quality.score < conditions.qualityScore) {
      reasons.push(`品質分數過低: ${quality.score} < ${conditions.qualityScore}`);
    }
    
    // 檢查信心度
    if (quality.confidence < conditions.confidenceScore) {
      reasons.push(`信心度過低: ${quality.confidence.toFixed(2)} < ${conditions.confidenceScore}`);
    }
    
    // 檢查重複內容
    if (quality.repetitionRatio > conditions.repetitionRatio) {
      reasons.push(`重複內容過多: ${(quality.repetitionRatio * 100).toFixed(1)}% > ${conditions.repetitionRatio * 100}%`);
    }
    
    // 檢查中文字元比例
    if (quality.chineseRatio < conditions.chineseRatio) {
      reasons.push(`中文字元過少: ${(quality.chineseRatio * 100).toFixed(1)}% < ${conditions.chineseRatio * 100}%`);
    }
    
    // 檢查連續失敗
    if (this.stats.consecutiveFailures >= conditions.consecutiveFailures) {
      reasons.push(`連續失敗次數過多: ${this.stats.consecutiveFailures} >= ${conditions.consecutiveFailures}`);
    }
    
    // 檢查整體系統表現
    if (this.stats.averageQuality < conditions.qualityScore && this.stats.qualityHistory.length >= 10) {
      reasons.push(`系統整體品質下降: ${this.stats.averageQuality.toFixed(1)} < ${conditions.qualityScore}`);
    }
    
    if (reasons.length > 0) {
      logger.warn(`建議降級到 OpenAI API:`);
      reasons.forEach(reason => logger.warn(`- ${reason}`));
      
      return {
        shouldFallback: true,
        reasons: reasons,
        confidence: this.calculateFallbackConfidence(reasons.length)
      };
    }
    
    return {
      shouldFallback: false,
      reasons: [],
      confidence: 0
    };
  }

  /**
   * 計算降級建議的信心度
   */
  calculateFallbackConfidence(reasonCount) {
    // 觸發條件越多，建議信心度越高
    return Math.min(0.9, 0.3 + (reasonCount * 0.15));
  }

  /**
   * 獲取品質等級
   */
  getQualityLevel(score) {
    if (score >= QUALITY_THRESHOLDS.EXCELLENT) return 'EXCELLENT';
    if (score >= QUALITY_THRESHOLDS.GOOD) return 'GOOD';
    if (score >= QUALITY_THRESHOLDS.ACCEPTABLE) return 'ACCEPTABLE';
    if (score >= QUALITY_THRESHOLDS.POOR) return 'POOR';
    return 'FAIL';
  }

  /**
   * 生成品質報告
   */
  generateQualityReport() {
    const successRate = this.stats.totalTranscriptions > 0 
      ? (this.stats.successfulTranscriptions / this.stats.totalTranscriptions) * 100 
      : 0;
    
    const recentQuality = this.stats.qualityHistory.slice(-10);
    const qualityTrend = this.calculateTrend(recentQuality.map(q => q.score));
    
    return {
      overview: {
        totalTranscriptions: this.stats.totalTranscriptions,
        successRate: successRate.toFixed(1),
        averageQuality: this.stats.averageQuality.toFixed(1),
        averageConfidence: this.stats.averageConfidence.toFixed(2),
        qualityLevel: this.getQualityLevel(this.stats.averageQuality)
      },
      trends: {
        qualityTrend: qualityTrend,
        recentPerformance: recentQuality.map(q => ({
          timestamp: q.timestamp,
          score: q.score,
          confidence: q.confidence
        }))
      },
      alerts: {
        consecutiveFailures: this.stats.consecutiveFailures,
        lastFailureTime: this.stats.lastFailureTime,
        systemHealth: this.assessSystemHealth()
      }
    };
  }

  /**
   * 計算趨勢
   */
  calculateTrend(values) {
    if (values.length < 2) return 'STABLE';
    
    const recent = values.slice(-5);
    const earlier = values.slice(-10, -5);
    
    if (recent.length === 0 || earlier.length === 0) return 'STABLE';
    
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
    
    const difference = recentAvg - earlierAvg;
    
    if (difference > 5) return 'IMPROVING';
    if (difference < -5) return 'DECLINING';
    return 'STABLE';
  }

  /**
   * 評估系統健康度
   */
  assessSystemHealth() {
    const successRate = this.stats.totalTranscriptions > 0 
      ? (this.stats.successfulTranscriptions / this.stats.totalTranscriptions) * 100 
      : 100;
    
    if (successRate >= 95 && this.stats.averageQuality >= 80) {
      return 'EXCELLENT';
    } else if (successRate >= 90 && this.stats.averageQuality >= 70) {
      return 'GOOD';
    } else if (successRate >= 80 && this.stats.averageQuality >= 60) {
      return 'ACCEPTABLE';
    } else if (successRate >= 70 && this.stats.averageQuality >= 50) {
      return 'POOR';
    } else {
      return 'CRITICAL';
    }
  }

  /**
   * 保存統計資料
   */
  saveStats() {
    try {
      const statsPath = path.join(__dirname, '../../data/quality-stats.json');
      const dir = path.dirname(statsPath);
      
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(statsPath, JSON.stringify(this.stats, null, 2));
    } catch (error) {
      logger.error(`保存統計資料失敗: ${error.message}`);
    }
  }

  /**
   * 載入統計資料
   */
  loadStats() {
    try {
      const statsPath = path.join(__dirname, '../../data/quality-stats.json');
      
      if (fs.existsSync(statsPath)) {
        const data = fs.readFileSync(statsPath, 'utf8');
        this.stats = { ...this.stats, ...JSON.parse(data) };
        
        // 轉換日期字串回 Date 物件
        this.stats.qualityHistory.forEach(item => {
          if (typeof item.timestamp === 'string') {
            item.timestamp = new Date(item.timestamp);
          }
        });
        
        if (this.stats.lastFailureTime && typeof this.stats.lastFailureTime === 'string') {
          this.stats.lastFailureTime = new Date(this.stats.lastFailureTime);
        }
        
        logger.info('統計資料已載入');
      }
    } catch (error) {
      logger.error(`載入統計資料失敗: ${error.message}`);
    }
  }

  /**
   * 重置統計資料
   */
  resetStats() {
    this.stats = {
      totalTranscriptions: 0,
      successfulTranscriptions: 0,
      failedTranscriptions: 0,
      averageQuality: 0,
      averageConfidence: 0,
      consecutiveFailures: 0,
      qualityHistory: [],
      lastFailureTime: null
    };
    
    this.saveStats();
    logger.info('統計資料已重置');
  }
}

module.exports = QualityMonitor;