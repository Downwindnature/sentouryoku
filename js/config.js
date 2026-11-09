// =====================================================================
//  戰力名單 — 設定檔（只需要改這個檔案）
// =====================================================================

// ① Firebase 設定
//    到 Firebase 主控台 → 專案設定（齒輪）→ 一般 → 你的應用程式 → 「SDK 設定和配置」
//    把 firebaseConfig 那一整段的值貼進來。databaseURL 一定要有。
//    apiKey 留空的話，網站會用「示範模式」執行：資料只存在這台電腦的瀏覽器裡。
export const firebaseConfig = {
  apiKey: "AIzaSyDRCwC3pbmuJgintM_HwislLwwKQ-CDvnU",
  authDomain: "sentouryoku.firebaseapp.com",
  databaseURL: "https://sentouryoku-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "sentouryoku",
  storageBucket: "sentouryoku.firebasestorage.app",
  messagingSenderId: "415744445104",
  appId: "1:415744445104:web:3762503e91d6a9a7358975",
  measurementId: "G-X0T1PJL4C1"
};

// ② 網站設定
export const settings = {
  siteTitle: "戰力名單",   // 瀏覽器分頁上的名稱
  pageSize: 5,             // 一頁最多顯示幾筆名單
  historyLimit: 50,        // 每筆名單最多保留幾筆過往紀錄（0 = 不限制）
  imageMaxSide: 1600,      // 圖片長邊上限（像素），超過會自動縮小壓縮
  gifMaxMB: 8,             // GIF 檔案大小上限（MB）
  videoMaxMB: 20,          // 影片檔案大小上限（MB）
  avatarMaxMB: 5           // GIF／MP4 動態頭像的大小上限（MB）；名單每次被打開都會下載，小一點比較省流量
};
