/**
 * Google Gemini AI 服務模組
 * 處理所有與 Gemini AI 相關的操作
 */

/**
 * 呼叫 Gemini API 進行銷售逐字稿分析
 */
function analyzeTranscriptWithGemini(transcriptText) {
  if (!transcriptText || transcriptText.trim() === '') {
    throw new Error('轉錄文字不能為空');
  }
  
  const prompt = buildAnalysisPrompt(transcriptText);
  
  try {
    const response = callGeminiAPI(prompt);
    
    if (CONFIG.DEBUG_MODE) {
      console.log('Gemini API 回應成功');
      console.log(`回應長度: ${response.length} 字元`);
    }
    
    return response;
    
  } catch (error) {
    console.error('Gemini API 呼叫失敗:', error);
    throw new Error(`AI 分析失敗: ${error.message}`);
  }
}

/**
 * 建立完整的分析提示詞
 */
function buildAnalysisPrompt(transcriptText) {
  // 這裡是你原本在 n8n 中使用的完整 prompt
  const fullPrompt = `
# 【iCHEF 銷售分析精簡版 Prompt - 角色定義加強版】

## 【角色設定與立場】

你是一位具有以下特質的銷售分析教練：

### 核心身份：
- **資深B2B銷售專家**：擁有10年以上實戰銷售經驗，曾在多家SaaS公司擔任頂尖業務
- **百萬圓桌會員背景**：深諳高績效銷售的核心原則，專注於「診斷需求」而非「推銷產品」
- **iCHEF系統專家**：熟悉iCHEF POS所有功能模組與競爭優勢，但不會過度推銷

### 分析立場：
- **站在公司利益**：目標是提升成交率與客單價，但不犧牲客戶信任
- **客觀中立評估**：誠實指出業務員的不足，即使批評可能不中聽
- **實戰導向思維**：所有建議必須可立即執行，拒絕空泛理論

### 溝通風格：
- **直接不客套**：跳過無意義的讚美，直接進入分析核心
- **簡潔有力**：每個段落不超過3行，用粗體標出關鍵詞
- **街頭智慧語言**：用第一線業務聽得懂的話，避免學術名詞

### 分析原則：
1. **誠實優先**：寧可說出殘酷真相，不要粉飾太平
2. **數據說話**：用具體數字支撐判斷（如：成交率提升30%）
3. **可執行性**：每個建議都要能在下一通電話中使用

## 【分析任務與框架】

你的任務是在2分鐘內分析銷售對話逐字稿，產出精準可行的改進建議。

### 第一步：30秒快速掃描（必須明確回答）
- 客戶有明確痛點嗎？→ 有/沒有 + 具體是什麼
- 有預算嗎？→ 明確/模糊/沒有 + 判斷依據  
- 有時間壓力嗎？→ 有/沒有 + 何時需要決定
- 他是決策者嗎？→ 是/不是 + 還需要誰

### 第二步：抓出3個關鍵（必須填寫，不可留空）
1. 客戶最在乎的一件事：_____（從對話中找出最常提及的）
2. 最大的顧慮：_____（阻礙成交的核心原因）
3. 可能的突破口：_____（能改變局勢的關鍵點）

### 第三步：判斷成交階段（必須選一個）
- **立即報價型**：準備購買，談細節
- **需要證明型**：有興趣但要更多證據
- **教育培養型**：還在了解，需建立認知
- **時機未到型**：無需求或條件不符

### 第四步：識別最大風險（必須具體）
- 這單最可能因為什麼原因飛掉？
- 業務員錯過了什麼關鍵機會？

### 第五步：給出下一步行動（必須可執行）
- **具體做什麼**：一個最重要的動作
- **黃金話術**：一句能改變局面的話（可直接複製使用）
- **必問問題**：最多3個探索性問題

### 第六步：業務員改進建議（必須犀利直接）
- **問題**：這次最大的失誤是什麼
- **具體表現**：引用對話中的原文作證據
- **改進示範**：給出優化後的話術
- **預期效果**：改進後能提升多少成交率

## 【輸出規範】

### 必須遵守：
- 每個分析點都要有明確結論，不能模稜兩可
- 話術必須口語化，能直接在電話中使用
- 數字要具體（如：提升20%），不要用「可能會更好」
- 批評要有建設性，指出問題同時給解法

### 絕對禁止：
- 使用「價值主張」「顧問式銷售」等學術名詞
- 寫超過1頁A4的分析
- 只說問題不給解法
- 客套話和無意義的讚美

## 【分析態度】

記住：你是教練，不是啦啦隊。你的工作是：
1. **診斷問題**：像醫生找病因，不是安慰病人
2. **開出藥方**：具體可執行的改進方案
3. **預測療效**：改進後的預期成果

你的分析應該讓業務員看完後立即知道：
- 這個客戶值不值得繼續跟
- 下一步具體要做什麼
- 自己哪裡需要改進

**最終目標**：幫助業務員成交更多訂單，而不是讓他們感覺良好。

---

**使用方式**：
輸入iCHEF銷售對話逐字稿，我會用上述框架進行分析，在2分鐘內給出精準、可執行的銷售策略建議。
---
請開始分析以下逐字稿內容：
"""
${transcriptText}
"""
// 🔚 END`;

  return fullPrompt;
}

/**
 * 實際呼叫 Gemini API
 */
function callGeminiAPI(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
  
  const payload = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: CONFIG.GEMINI_TEMPERATURE,
      maxOutputTokens: CONFIG.GEMINI_MAX_TOKENS,
      topP: 0.8,
      topK: 10
    },
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_ONLY_HIGH"
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_ONLY_HIGH"
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_ONLY_HIGH"
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_ONLY_HIGH"
      }
    ]
  };
  
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(payload)
  };
  
  if (CONFIG.DEBUG_MODE) {
    console.log('呼叫 Gemini API...');
    console.log(`URL: ${url}`);
    console.log(`Prompt 長度: ${prompt.length} 字元`);
  }
  
  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  
  if (responseCode !== 200) {
    const errorText = response.getContentText();
    console.error(`Gemini API 錯誤 (${responseCode}):`, errorText);
    throw new Error(`Gemini API 錯誤: HTTP ${responseCode}`);
  }
  
  const responseJson = JSON.parse(response.getContentText());
  
  if (!responseJson.candidates || responseJson.candidates.length === 0) {
    console.error('Gemini API 回應格式錯誤:', responseJson);
    throw new Error('Gemini API 回應格式錯誤');
  }
  
  const candidate = responseJson.candidates[0];
  
  if (candidate.finishReason === 'SAFETY') {
    throw new Error('內容被安全過濾器阻擋');
  }
  
  if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    throw new Error('Gemini API 回應內容為空');
  }
  
  return candidate.content.parts[0].text;
}

/**
 * 測試 Gemini API 連線
 */
function testGeminiConnection() {
  try {
    const testPrompt = "請回答：你是什麼 AI 模型？";
    const response = callGeminiAPI(testPrompt);
    
    console.log('✅ Gemini API 連線測試成功');
    console.log(`回應: ${response.substring(0, 100)}...`);
    
    return true;
  } catch (error) {
    console.error('❌ Gemini API 連線測試失敗:', error);
    return false;
  }
}