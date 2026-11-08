// Firebase 版：Realtime Database ＋ 背景匿名登入
// 使用者不用登入；匿名登入只是讓資料庫知道寫入是從這個網站來的（規則要求 auth != null 才能寫）
// SDK 直接從 Google 官方 CDN 載入，不需要安裝任何東西
const SDK = 'https://www.gstatic.com/firebasejs/12.15.0/';

export async function createFirebaseAdapter(config) {
  const [appMod, authMod, dbMod] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-database.js')
  ]);

  const app = appMod.initializeApp(config);
  const auth = authMod.getAuth(app);
  const db = dbMod.getDatabase(app);
  const r = path => (path ? dbMod.ref(db, path) : dbMod.ref(db));

  // 伺服器時間差（讓每個人寫入的時間一致）
  let offset = 0;
  dbMod.onValue(r('.info/serverTimeOffset'), s => { offset = Number(s.val()) || 0; });

  // 匿名登入（同一個瀏覽器下次打開會沿用同一個匿名帳號）
  let authError = null;
  let resolveAuth;
  const authReady = new Promise(res => { resolveAuth = res; });
  authMod.onAuthStateChanged(auth, u => { if (u) resolveAuth(true); });
  authMod.signInAnonymously(auth).catch(e => { authError = e; resolveAuth(!!auth.currentUser); });
  const needAuth = async () => {
    if (!(await authReady)) throw authError || Object.assign(new Error('auth failed'), { code: 'auth/operation-not-allowed' });
  };

  return {
    mode: 'firebase',
    persistent: true,
    now: () => Date.now() + offset,
    ready: needAuth,
    async get(path) {
      const snap = await dbMod.get(r(path));
      return snap.exists() ? snap.val() : null;
    },
    async set(path, value) { await needAuth(); return dbMod.set(r(path), value); },
    async update(path, obj) { await needAuth(); return dbMod.update(r(path), obj); },
    async remove(path) { await needAuth(); return dbMod.remove(r(path)); },
    on(path, cb, errCb) {
      return dbMod.onValue(r(path), snap => cb(snap.val()), err => { if (errCb) errCb(err); });
    },
    onConnection(cb) { return dbMod.onValue(r('.info/connected'), s => cb(!!s.val())); }
  };
}
