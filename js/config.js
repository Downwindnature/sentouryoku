// =====================================================================
//  戰力名單 — 設定檔（只需要改這個檔案）
// =====================================================================

// ① Firebase 設定
//    到 Firebase 主控台 → 專案設定（齒輪）→ 一般 → 你的應用程式 → 「SDK 設定和配置」
//    把 firebaseConfig 那一整段的值貼進來。databaseURL 一定要有。
//    apiKey 留空的話，網站會用「示範模式」執行：資料只存在這台電腦的瀏覽器裡。
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  databaseURL: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

// ② 網站設定
export const settings = {
  siteTitle: "戰力名單",   // 瀏覽器分頁上的名稱
  pageSize: 5,             // 一頁最多顯示幾筆名單
  historyLimit: 50,        // 每筆名單最多保留幾筆過往紀錄（0 = 不限制）
  imageMaxSide: 1600,      // 圖片長邊上限（像素），超過會自動縮小壓縮
  gifMaxMB: 8,             // GIF 檔案大小上限（MB）
  videoMaxMB: 20           // 影片檔案大小上限（MB）
};
