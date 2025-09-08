/**
 * Google Apps Script - 檔案上傳觸發處理
 * 處理 Google Drive 中新上傳的音檔，解析檔名並更新對應的 Google Sheet 資料。
 */

/**
 * 當檔案在指定資料夾中建立時，由 Google Apps Script 觸發器自動呼叫此函式。
 * @param {Object} e - Google Apps Script 的事件物件，包含了觸發事件的相關資訊。
 */
function onFileCreate(e) {
  try {
    if (!e || !e.source) {
      console.error('onFileCreate: 事件物件無效或缺少來源資訊。');
      return;
    }
    const fileId = e.source.getId();
    console.log(`偵測到新檔案，ID: ${fileId}。開始處理...`);
    processUploadedAudioFile(fileId);
  } catch (error) {
    console.error(`onFileCreate 執行失敗: ${error.toString()}`);
  }
}

/**
 * 處理單一上傳的音檔。
 * @param {string} fileId - 新上傳檔案的 Google Drive ID。
 */
function processUploadedAudioFile(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    const fileName = file.getName();
    console.log(`正在處理檔案: ${fileName}`);

    // 1. 解析檔名
    const parsedInfo = parseFileName(fileName);
    if (!parsedInfo) {
      console.warn(`檔案 "${fileName}" 的格式不符合預期，已跳過處理。`);
      return;
    }
    
    const { caseId, storeName } = parsedInfo;
    console.log(`解析結果 -> Case_ID: ${caseId}, 店家名稱: ${storeName}`);

    // 2. 更新 Google Sheet
    updateStoreNameInSheet(caseId, storeName);

  } catch (error) {
    console.error(`處理檔案 ID ${fileId} 時發生錯誤: ${error.toString()}`);
  }
}

/**
 * 從檔名中解析出 Case_ID 和店家名稱。
 * 檔名格式: "YYYYMM-CustomerID_店家名稱 - 業務名稱.xxx"
 * @param {string} fileName - 檔案名稱。
 * @returns {Object|null} - 包含 caseId 和 storeName 的物件，或在格式不符時返回 null。
 */
function parseFileName(fileName) {
  // 增加對傳入參數的檢查，避免 undefined 錯誤
  if (!fileName || typeof fileName !== 'string') {
    console.warn('parseFileName 收到的 fileName 無效。');
    return null;
  }

  const underscoreIndex = fileName.indexOf('_');
  const dashIndex = fileName.indexOf(' - ');

  if (underscoreIndex === -1 || dashIndex === -1 || dashIndex < underscoreIndex) {
    return null; // 格式不符
  }

  const caseId = fileName.substring(0, underscoreIndex).trim();
  const storeName = fileName.substring(underscoreIndex + 1, dashIndex).trim();

  return { caseId, storeName };
}

/**
 * 在 Google Sheet 中找到對應的 Case_ID，並更新其店家名稱。
 * @param {string} caseId - 要尋找的 Case ID。
 * @param {string} storeName - 要更新的店家名稱。
 */
function updateStoreNameInSheet(caseId, storeName) {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) {
      console.error(`找不到工作表: ${CONFIG.SHEET_NAME}`);
      return;
    }

    const caseIdColumn = sheet.getRange("A1:A" + sheet.getLastRow()).getValues();
    let rowToUpdate = -1;

    // 從第一列開始找 (索引 0)，以符合 A1 開始的範圍
    for (let i = 0; i < caseIdColumn.length; i++) {
      if (caseIdColumn[i][0].toString().trim() === caseId) {
        rowToUpdate = i + 1; // 找到的列號 (1-based)
        break;
      }
    }

    if (rowToUpdate !== -1) {
      // T 欄是第 20 欄
      sheet.getRange(rowToUpdate, 20).setValue(storeName);
      console.log(`成功更新 Case_ID "${caseId}" 的店家名稱為 "${storeName}" (第 ${rowToUpdate} 列)。`);
    } else {
      console.warn(`在工作表中找不到對應的 Case_ID: "${caseId}"。`);
    }
  } catch (error) {
    console.error(`更新工作表時發生錯誤: ${error.toString()}`);
  }
}
