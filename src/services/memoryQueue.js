/**
 * 內存佇列實現 - Bull Queue 的簡化替代方案
 * 當 Redis 不可用時使用
 */

const EventEmitter = require('events');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

class MemoryQueue extends EventEmitter {
  constructor(name = 'memory-queue') {
    super();
    this.name = name;
    this.jobs = new Map();
    this.jobId = 1;
    this.processing = false;
    this.processors = [];
    this.concurrency = 1;
    
    logger.info(`🔄 內存佇列已初始化: ${name}`);
  }

  // 添加任務到佇列
  async add(data, options = {}) {
    const job = {
      id: this.jobId++,
      data,
      options,
      status: 'waiting',
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: options.attempts || 3,
      result: null,
      error: null
    };
    
    this.jobs.set(job.id, job);
    
    logger.info(`📝 任務已添加到內存佇列 - Job ID: ${job.id}`);
    
    // 立即嘗試處理任務
    setImmediate(() => this._processNextJob());
    
    return {
      id: job.id,
      data: job.data
    };
  }

  // 設定處理器
  process(concurrency, processor) {
    if (typeof concurrency === 'function') {
      processor = concurrency;
      concurrency = 1;
    }
    
    this.concurrency = concurrency;
    this.processors.push(processor);
    
    logger.info(`🔧 設定內存佇列處理器 - 並發數: ${concurrency}`);
  }

  // 處理下一個任務
  async _processNextJob() {
    if (this.processing || this.processors.length === 0) {
      return;
    }

    const waitingJob = Array.from(this.jobs.values()).find(job => job.status === 'waiting');
    if (!waitingJob) {
      return;
    }

    this.processing = true;
    waitingJob.status = 'active';
    waitingJob.attempts++;

    logger.info(`🎬 開始處理內存佇列任務 - Job ID: ${waitingJob.id}, 嘗試次數: ${waitingJob.attempts}`);

    try {
      const processor = this.processors[0]; // 使用第一個處理器
      const result = await processor({ 
        id: waitingJob.id, 
        data: waitingJob.data 
      });
      
      waitingJob.status = 'completed';
      waitingJob.result = result;
      
      logger.info(`✅ 內存佇列任務完成 - Job ID: ${waitingJob.id}`);
      
    } catch (error) {
      logger.error(`❌ 內存佇列任務失敗 - Job ID: ${waitingJob.id}, 錯誤: ${error.message}`);
      
      if (waitingJob.attempts < waitingJob.maxAttempts) {
        waitingJob.status = 'waiting';
        logger.info(`🔄 任務將重試 - Job ID: ${waitingJob.id}, 剩餘嘗試次數: ${waitingJob.maxAttempts - waitingJob.attempts}`);
      } else {
        waitingJob.status = 'failed';
        waitingJob.error = error.message;
        this.emit('failed', waitingJob, error);
      }
    }

    this.processing = false;
    
    // 處理下一個任務
    setImmediate(() => this._processNextJob());
  }

  // 獲取任務
  async getJob(jobId) {
    const job = this.jobs.get(parseInt(jobId));
    if (!job) {
      return null;
    }

    return {
      id: job.id,
      data: job.data,
      progress: job.status === 'completed' ? 100 : (job.status === 'active' ? 50 : 0),
      returnvalue: job.result,
      failedReason: job.error
    };
  }

  // 獲取任務狀態
  async getState(jobId) {
    const job = this.jobs.get(parseInt(jobId));
    return job ? job.status : null;
  }

  // 獲取佇列統計
  async getJobCounts() {
    const stats = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0
    };

    for (const job of this.jobs.values()) {
      stats[job.status] = (stats[job.status] || 0) + 1;
    }

    return stats;
  }

  // 關閉佇列
  async close() {
    logger.info(`🛑 關閉內存佇列: ${this.name}`);
    this.jobs.clear();
    this.processors = [];
    return Promise.resolve();
  }

  // 模擬 Bull Queue 的事件
  on(event, handler) {
    super.on(event, handler);
    
    // 模擬立即觸發 ready 事件
    if (event === 'ready') {
      setImmediate(() => handler());
    }
  }
}

module.exports = MemoryQueue;