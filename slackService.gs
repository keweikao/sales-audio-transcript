/**
 * Slack 通知服務模組
 * 處理所有與 Slack 相關的操作
 */

/**
 * 發送 AI 分析結果通知到 Slack
 */
function sendSlackNotification(caseId, storeName, analysisOutput, salespersonEmail, feedbackFormUrl) {
  const slackId = getSalespersonSlackId(salespersonEmail);
  
  if (!slackId) {
    console.warn(`無法找到 ${salespersonEmail} 的 Slack ID，跳過通知`);
    return false;
  }
  
  try {
    const message = buildSlackMessage(caseId, storeName, analysisOutput, feedbackFormUrl);
    const success = sendDirectMessage(slackId, message);
    
    if (success && CONFIG.DEBUG_MODE) {
      console.log(`✅ 成功發送 Slack 通知給 ${salespersonEmail} (${slackId})`);
    }
    
    return success;
    
  } catch (error) {
    console.error(`❌ 發送 Slack 通知失敗 (${salespersonEmail}):`, error);
    return false;
  }
}

/**
 * 建立 Slack 訊息內容
 */
function buildSlackMessage(caseId, storeName, analysisOutput, feedbackFormUrl) {
  const message = `您好！關於客戶 ${storeName} (編號: ${caseId}) 的 AI 分析報告已產生：

${analysisOutput}

---

💬 **想要深入討論這個案例嗎？**

🔸 **直接在此對話中提問**
   使用格式：\`案例 ${caseId} - [您的問題]\`

📋 **討論問題範例：**
• \`案例 ${caseId} - 請詳細解釋第2個風險點\`
• \`案例 ${caseId} - 這個客戶適合哪個價格方案？\`
• \`案例 ${caseId} - 下次拜訪重點是什麼？\`
• \`案例 ${caseId} - 如何回應預算不足的反對意見？\`

🤖 **AI 教練可以協助您：**
• 解釋分析結果的具體含義
• 提供更詳細的追蹤策略
• 準備客戶拜訪重點
• 模擬客戶可能的反應
• 推薦合適的產品組合和話術

📝 **回饋表單：${feedbackFormUrl}**

⚡ **AI 會在幾秒內自動回覆您的問題**

感謝您的協助！`;

  return message;
}

/**
 * 發送私訊給指定的 Slack 用戶
 */
function sendDirectMessage(userId, message) {
  const url = 'https://slack.com/api/chat.postMessage';
  
  const payload = {
    channel: userId,
    text: message,
    as_user: true
  };
  
  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    payload: JSON.stringify(payload)
  };
  
  if (CONFIG.DEBUG_MODE) {
    console.log(`發送 Slack 訊息給用戶: ${userId}`);
    console.log(`訊息長度: ${message.length} 字元`);
  }
  
  const response = UrlFetchApp.fetch(url, options);
  const responseJson = JSON.parse(response.getContentText());
  
  if (!responseJson.ok) {
    console.error('Slack API 錯誤:', responseJson);
    throw new Error(`Slack API 錯誤: ${responseJson.error}`);
  }
  
  return true;
}

/**
 * 獲取 Slack 用戶資訊 (用於偵錯)
 */
function getSlackUserInfo(userId) {
  const url = `https://slack.com/api/users.info?user=${userId}`;
  
  const options = {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`
    }
  };
  
  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseJson = JSON.parse(response.getContentText());
    
    if (responseJson.ok) {
      return responseJson.user;
    } else {
      console.error('取得 Slack 用戶資訊失敗:', responseJson.error);
      return null;
    }
  } catch (error) {
    console.error('Slack API 呼叫失敗:', error);
    return null;
  }
}

/**
 * 測試 Slack API 連線
 */
function testSlackConnection() {
  const url = 'https://slack.com/api/auth.test';
  
  const options = {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`
    }
  };
  
  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseJson = JSON.parse(response.getContentText());
    
    if (responseJson.ok) {
      console.log('✅ Slack API 連線測試成功');
      console.log(`Bot 用戶: ${responseJson.user}`);
      console.log(`團隊: ${responseJson.team}`);
      return true;
    } else {
      console.error('❌ Slack API 連線測試失敗:', responseJson.error);
      return false;
    }
  } catch (error) {
    console.error('❌ Slack API 連線測試失敗:', error);
    return false;
  }
}

/**
 * 發送錯誤通知給管理員
 */
function sendErrorNotification(errorMessage, caseId = null) {
  if (!ERROR_CONFIG.ENABLE_ERROR_NOTIFICATION) {
    return;
  }
  
  const subject = `🚨 Sales AI 系統錯誤通知${caseId ? ` - 案例 ${caseId}` : ''}`;
  const body = `
銷售 AI 分析系統發生錯誤：

錯誤時間：${new Date().toLocaleString('zh-TW')}
案例編號：${caseId || '未知'}
錯誤訊息：${errorMessage}

請檢查系統狀態並進行必要的修復。

---
此為系統自動發送的通知訊息
  `;
  
  try {
    MailApp.sendEmail({
      to: ERROR_CONFIG.ERROR_NOTIFICATION_EMAIL,
      subject: subject,
      body: body
    });
    
    if (CONFIG.DEBUG_MODE) {
      console.log(`發送錯誤通知郵件給: ${ERROR_CONFIG.ERROR_NOTIFICATION_EMAIL}`);
    }
  } catch (error) {
    console.error('發送錯誤通知失敗:', error);
  }
}

/**
 * 批次發送測試訊息 (用於測試所有業務員的 Slack ID)
 */
function sendTestMessagesToAllSalespeople() {
  const testMessage = "🤖 這是一則測試訊息，確認 Sales AI 系統可以正常發送通知給您。請忽略此訊息。";
  const mapping = getUserMappingFromSheet();
  const results = [];
  
  for (const [email, slackId] of Object.entries(mapping)) {
    try {
      const success = sendDirectMessage(slackId, testMessage);
      results.push({
        email: email,
        slackId: slackId,
        success: success
      });
      
      console.log(`${success ? '✅' : '❌'} ${email} (${slackId})`);
      
      // 避免 API 限制，每次發送後等待 1 秒
      Utilities.sleep(1000);
      
    } catch (error) {
      console.error(`❌ ${email} (${slackId}): ${error.message}`);
      results.push({
        email: email,
        slackId: slackId,
        success: false,
        error: error.message
      });
    }
  }
  
  return results;
}

/**
 * 根據 Email 取得 Slack ID (從 Google Sheet 動態讀取)
 */
function getSalespersonSlackId(email) {
  const mapping = getUserMappingFromSheet();
  return mapping[email.toLowerCase()];
}

/**
 * 從 Google Sheet 讀取使用者對應表
 */
function getUserMappingFromSheet() {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName(CONFIG.USER_MAPPING_SHEET_NAME);
    
    if (!sheet) {
      throw new Error(`找不到名稱為 "${CONFIG.USER_MAPPING_SHEET_NAME}" 的分頁`);
    }
    
    const data = sheet.getDataRange().getValues();
    const mapping = {};
    
    // 從第二行開始讀取 (跳過標題)
    for (let i = 1; i < data.length; i++) {
      const email = data[i][0]; // A欄: Email
      const slackId = data[i][1]; // B欄: Slack ID
      
      if (email && slackId) {
        mapping[email.toLowerCase()] = slackId;
      }
    }
    
    return mapping;

  } catch (error) {
    console.error(`❌ 讀取使用者對應表失敗: ${error.message}`);
    sendErrorNotification(`讀取使用者對應表失敗: ${error.message}`);
    return {}; // 返回空物件以避免後續錯誤
  }
}