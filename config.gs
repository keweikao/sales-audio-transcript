/**
 * Google Apps Script - 銷售 AI 分析自動化系統
 * 設定檔 - 請填入你的實際參數
 */

// Google Sheets 設定
const CONFIG = {
  // Google Sheets
  SPREADSHEET_ID: '13YzC50h9oq1c-UETjKOP8tpmDQ7-pfmnwKTqnbx6Xgo', // 你的試算表 ID
  SHEET_NAME: 'Master_Log', // 工作表名稱
  
  // Gemini API 設定
  GEMINI_API_KEY: 'YOUR_GEMINI_API_KEY_HERE', // 請替換為你的 Gemini API Key
  GEMINI_MODEL: 'gemini-1.5-flash',
  GEMINI_MAX_TOKENS: 60000,
  GEMINI_TEMPERATURE: 0.2,
  
  // Slack 設定
  SLACK_BOT_TOKEN: 'YOUR_SLACK_BOT_TOKEN_HERE', // 請替換為你的 Slack Bot Token
  
  // 欄位對應 (根據你的 Google Sheets 結構)
  COLUMNS: {
    CASE_ID: 'A',           // Case_ID
    SUBMISSION_TIME: 'B',   // Submission_Timestamp
    SALESPERSON_EMAIL: 'C', // Salesperson_Email
    AUDIO_FILE_NAME: 'D',   // Audio_File_Name
    AUDIO_FILE_LINK: 'E',   // Audio_File_Link_GDrive
    TRANSCRIPTION_STATUS: 'F', // Transcription_Status
    TRANSCRIPT_TEXT: 'G',   // Transcript_Text
    AI_PROMPT_VERSION: 'H', // AI_Prompt_Version
    AI_ANALYSIS_OUTPUT: 'I', // AI_Analysis_Output
    NOTIFICATION_SENT: 'J', // Notification_Sent_Timestamp
    FEEDBACK_FORM_URL: 'K', // Feedback_Form_URL_Prefilled
    FEEDBACK_SUBMISSION: 'L', // Feedback_Submission_Timestamp
    CONVERSION_RATE: 'M',   // Sales_Feedback_Conversion_Rate
    FEEDBACK_REASONING: 'N', // Sales_Feedback_Reasoning
    DATA_STATUS: 'O',       // Data_Status
    SALESPERSON_SLACK_ID: 'P', // Salesperson_Slack_ID
    FEEDBACK_AI_COMPARISON: 'Q', // Sales_Feedback_AI_Comparison (新增)
    FEEDBACK_AI_OTHER: 'R',  // Sales_Feedback_AI_Other (新增)
    RETRY_COUNT: 'S',        // Retry_Count
    STORE_NAME: 'T'         // Store_Name (店家名稱)
  },
  
  // AI 提示版本
  PROMPT_VERSION: 'v7.0',
  
  // Google Form 預填網址模板
  FEEDBACK_FORM_TEMPLATE: 'https://docs.google.com/forms/d/e/1FAIpQLSdBqYbZKLTBBo0A7uVqCpqt5Q6QnSJN5SoS6ssvMHCviSgrpA/viewform?usp=pp_url&entry.1811022303=',
  
  // 回饋表單相關設定
  FEEDBACK_SPREADSHEET_ID: '1xWS-wWdO6yaFoxUXR0qo6A_Hd3Mvznk449jjz1qS4gg', // 回饋表單回應的試算表 ID
  FEEDBACK_SHEET_NAME: 'Form Responses 1', // 回饋表單回應的工作表名稱
  
  // 音檔上傳表單設定
  AUDIO_FORM_ID: '1Ao79f4t8iE-I0fLvFbo5M0wGadEwzGdnkxgEEe8ERm0', // 音檔上傳 Google Form ID
  AUDIO_FORM_SPREADSHEET_ID: '1-IN6pLywn7D-TqfyPceGGHfJwxCGhebj2l6pYHgyZ_o', // 音檔上傳表單回應的試算表 ID
  AUDIO_FORM_SHEET_NAME: 'Form Responses 1', // 音檔上傳表單回應的工作表名稱

  // Google Drive 音檔資料夾設定
  AUDIO_UPLOAD_FOLDER_ID: '16e_8YPpOSW9gvg1Kl0exYU2QEYpdglQk', // 存放音檔的 Google Drive 資料夾 ID

  // Zeabur 轉錄 API 設定
  ZEABUR_TRANSCRIPTION_URL: 'https://sales-audio-transcript.zeabur.app/transcribe',

  // 偵錯模式
  DEBUG_MODE: true,

  // 使用者對應表設定
  USER_MAPPING_SHEET_NAME: 'User_Mapping' // 存放 Email 與 Slack ID 對應關係的分頁名稱
};

/**
 * 錯誤處理設定
 */
const ERROR_CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // 毫秒
  ENABLE_ERROR_NOTIFICATION: true,
  ERROR_NOTIFICATION_EMAIL: 'your-admin@email.com' // 管理員 Email
};