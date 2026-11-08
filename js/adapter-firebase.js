// Firebase 版：Google 登入 + Realtime Database
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

  const toUser = u => u ? {
    uid: u.uid,
    name: u.displayName || (u.email ? u.email.split('@')[0] : '使用者'),
    email: u.email || '',
    photo: u.photoURL || ''
  } : null;

  return {
    mode: 'firebase',
    persistent: true,
    now: () => Date.now() + offset,
    onAuth(cb) { return authMod.onAuthStateChanged(auth, u => cb(toUser(u))); },
    async signIn() {
      const provider = new authMod.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await authMod.signInWithPopup(auth, provider);
    },
    async signOut() { await authMod.signOut(auth); },
    async get(path) {
      const snap = await dbMod.get(r(path));
      return snap.exists() ? snap.val() : null;
    },
    set: (path, value) => dbMod.set(r(path), value),
    update: (path, obj) => dbMod.update(r(path), obj),
    remove: path => dbMod.remove(r(path)),
    on(path, cb, errCb) {
      return dbMod.onValue(r(path), snap => cb(snap.val()), err => { if (errCb) errCb(err); });
    },
    onConnection(cb) { return dbMod.onValue(r('.info/connected'), s => cb(!!s.val())); }
  };
}
