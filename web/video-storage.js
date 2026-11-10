const DB_NAME = "joyverse-video-storage";
const STORE_NAME = "clips";
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("تعذّر فتح مساحة حفظ الفيديو."));
  });
}

export async function saveVideoBlob(id, blob) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(blob, id);
    transaction.oncomplete = () => { db.close(); resolve(id); };
    transaction.onerror = () => { const error = transaction.error; db.close(); reject(error || new Error("تعذّر حفظ الفيديو على الهاتف.")); };
    transaction.onabort = () => { const error = transaction.error; db.close(); reject(error || new Error("أُلغي حفظ الفيديو.")); };
  });
}

export async function getVideoBlob(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("تعذّرت قراءة الفيديو المحفوظ."));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => { const error = transaction.error; db.close(); reject(error); };
  });
}

export async function deleteVideoBlob(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { const error = transaction.error; db.close(); reject(error); };
  });
}
