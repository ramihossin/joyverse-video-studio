const $ = id => document.getElementById(id);
let activeSite = null;
let sites = [];
const tokenKey = "joyverse_browser_agent_token";
$("token").value = sessionStorage.getItem(tokenKey) || "";
function setStatus(id, text, kind) { $(id).textContent = text; $(id).className = "status " + (kind || ""); }
function getToken() { return $("token").value.trim(); }
async function api(path, options = {}) {
  const token = getToken();
  if (!token) throw new Error("أدخل رمز الوصول أولاً.");
  const headers = { Authorization: "Bearer " + token, ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}
function selectorData() {
  return {
    promptSelector: $("promptSelector").value.trim(),
    uploadSelector: $("uploadSelector").value.trim(),
    generateSelector: $("generateSelector").value.trim(),
    readySelector: $("readySelector").value.trim(),
    downloadSelector: $("downloadSelector").value.trim()
  };
}
function fillSite(site) {
  activeSite = site;
  $("siteName").value = site?.name || "";
  $("baseUrl").value = site?.baseUrl || "";
  $("loginUrl").value = site?.loginUrl || "";
  $("allowedHosts").value = (site?.allowedHosts || []).filter(h => h !== new URL(site.baseUrl).hostname).join(", ");
  for (const key of ["promptSelector","uploadSelector","generateSelector","readySelector","downloadSelector"]) {
    $(key).value = site?.selectors?.[key] || "";
  }
  $("waitSeconds").value = site?.waitSeconds || 300;
  setStatus("sessionStatus", site ? (site.hasSavedSession ? "توجد جلسة دخول محفوظة ومشفّرة لهذا الموقع." : "لا توجد جلسة محفوظة؛ سجّل الدخول ثم احفظها.") : "أضف موقعاً أو اختر موقعاً محفوظاً.");
}
async function loadSites() {
  const data = await api("/api/sites");
  sites = data.sites;
  const previous = $("siteSelect").value;
  $("siteSelect").innerHTML = '<option value="">— اختر موقعاً —</option>' + sites.map(s => '<option value="' + s.id + '">' + escapeHtml(s.name) + (s.hasSavedSession ? " ✓" : "") + '</option>').join("");
  if (sites.some(s => s.id === previous)) $("siteSelect").value = previous;
  else if (activeSite && sites.some(s => s.id === activeSite.id)) $("siteSelect").value = activeSite.id;
  const chosen = sites.find(s => s.id === $("siteSelect").value);
  if (chosen) fillSite(chosen);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function sitePayload() {
  return {
    name: $("siteName").value.trim(), baseUrl: $("baseUrl").value.trim(),
    loginUrl: $("loginUrl").value.trim(), allowedHosts: $("allowedHosts").value.split(",").map(x=>x.trim()).filter(Boolean),
    selectors: selectorData(), waitSeconds: Number($("waitSeconds").value || 300)
  };
}
async function connect() {
  sessionStorage.setItem(tokenKey, getToken());
  await api("/health").catch(()=>null);
  await loadSites();
  setStatus("connection", "متصل بالخدمة", "good");
}
$("connect").onclick = () => connect().catch(e => setStatus("connection", e.message, "bad"));
$("forgetToken").onclick = () => { sessionStorage.removeItem(tokenKey); $("token").value=""; setStatus("connection","تم مسح الرمز",""); };
$("newSite").onclick = () => { $("siteSelect").value=""; fillSite(null); };
$("clearForm").onclick = () => fillSite(null);
$("siteSelect").onchange = () => fillSite(sites.find(s=>s.id===$("siteSelect").value) || null);
$("saveSite").onclick = async () => {
  try {
    const payload = sitePayload();
    const data = activeSite?.id
      ? await api("/api/sites/" + activeSite.id, { method:"PUT", body:JSON.stringify(payload) })
      : await api("/api/sites", { method:"POST", body:JSON.stringify(payload) });
    activeSite = data.site;
    await loadSites();
    $("siteSelect").value = activeSite.id;
    fillSite(activeSite);
    setStatus("sessionStatus","تم حفظ إعدادات الموقع.","good");
  } catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
$("deleteSite").onclick = async () => {
  try {
    if (!activeSite) throw new Error("اختر موقعاً أولاً.");
    if (!confirm("حذف ملف هذا الموقع وجلسة دخوله المحفوظة؟")) return;
    await api("/api/sites/" + activeSite.id, { method:"DELETE" });
    activeSite=null; $("siteSelect").value=""; fillSite(null); await loadSites();
  } catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
async function refreshScreen() {
  const d = await api("/api/browser/screenshot", { method:"GET" });
  $("screen").src = "data:image/jpeg;base64," + d.imageBase64;
}
$("openSite").onclick = async () => {
  try {
    if (!activeSite) throw new Error("اختر أو احفظ موقعاً أولاً.");
    const result = await api("/api/sites/" + activeSite.id + "/open", { method:"POST", body:"{}" });
    setStatus("sessionStatus", "تم فتح " + result.title + "\n" + result.url + "\n" + (result.sessionRestored ? "استعيدت الجلسة المحفوظة." : "سجّل الدخول بنفسك ثم احفظ الجلسة."), "good");
    await refreshScreen();
  } catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
$("refreshScreen").onclick = () => refreshScreen().catch(e => setStatus("sessionStatus",e.message,"bad"));
$("saveSession").onclick = async () => {
  try {
    const d = await api("/api/browser/save-session",{method:"POST",body:"{}"});
    setStatus("sessionStatus","تم حفظ جلسة الموقع بصورة مشفّرة في مخزن الجلسات. "+d.savedAt,"good");
    await loadSites();
  } catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
$("clearSession").onclick = async () => {
  try {
    if (!activeSite) throw new Error("اختر موقعاً أولاً.");
    if (!confirm("سيتم حذف جلسة الدخول المحفوظة لهذا الموقع. ستحتاج إلى تسجيل الدخول مجدداً. متابعة؟")) return;
    await api("/api/sites/"+activeSite.id+"/session",{method:"DELETE"});
    await loadSites();
    setStatus("sessionStatus","حُذفت جلسة الدخول المحفوظة لهذا الموقع.","good");
  } catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
$("closeBrowser").onclick = async () => {
  try { await api("/api/browser/close",{method:"POST",body:"{}"}); $("screen").removeAttribute("src"); setStatus("sessionStatus","أُغلق المتصفح بعد حفظ الجلسة.","good"); }
  catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
$("screen").onclick = async event => {
  try {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) * 1365 / rect.width;
    const y = (event.clientY - rect.top) * 900 / rect.height;
    await api("/api/browser/click",{method:"POST",body:JSON.stringify({x,y})});
    setTimeout(()=>refreshScreen().catch(()=>{}),700);
  } catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
$("scrollUp").onclick = () => api("/api/browser/scroll",{method:"POST",body:JSON.stringify({deltaY:-650})}).then(refreshScreen).catch(e=>setStatus("sessionStatus",e.message,"bad"));
$("scrollDown").onclick = () => api("/api/browser/scroll",{method:"POST",body:JSON.stringify({deltaY:650})}).then(refreshScreen).catch(e=>setStatus("sessionStatus",e.message,"bad"));
$("sendText").onclick = async () => {
  try { const text=$("typing").value; await api("/api/browser/type",{method:"POST",body:JSON.stringify({text})}); $("typing").value=""; setTimeout(()=>refreshScreen().catch(()=>{}),250); }
  catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
$("pressEnter").onclick = () => api("/api/browser/key",{method:"POST",body:JSON.stringify({key:"Enter"})}).then(refreshScreen).catch(e=>setStatus("sessionStatus",e.message,"bad"));
$("pressTab").onclick = () => api("/api/browser/key",{method:"POST",body:JSON.stringify({key:"Tab"})}).then(refreshScreen).catch(e=>setStatus("sessionStatus",e.message,"bad"));
$("inspect").onclick = async () => {
  try {
    const d = await api("/api/browser/snapshot");
    $("controlsList").innerHTML = "";
    const candidates = d.controls.filter(c => ["input","textarea","button","a","video"].includes(c.tag));
    for (const c of candidates) {
      const row = document.createElement("div"); row.className="control";
      const code = document.createElement("code"); code.textContent = c.selector + (c.text ? " — " + c.text : "");
      const actions = document.createElement("div"); actions.className="row";
      const mk = (label,key) => { const b=document.createElement("button");b.textContent=label;b.onclick=()=>{$(key).value=c.selector;};actions.appendChild(b); };
      if (c.tag==="input" || c.tag==="textarea") mk("حقل الوصف","promptSelector");
      if (c.type==="file") mk("رفع الصورة","uploadSelector");
      if (c.tag==="button" || c.tag==="a") { mk("زر التوليد","generateSelector"); mk("زر التنزيل","downloadSelector"); }
      if (c.tag==="video") mk("عنصر جاهزية النتيجة","readySelector");
      row.append(code,actions); $("controlsList").appendChild(row);
    }
    setStatus("sessionStatus","عنوان الصفحة: "+d.title+"\nتم اكتشاف "+candidates.length+" عنصراً قابلاً للاستخدام. اختر المحدد المناسب لكل وظيفة.","good");
  } catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
$("saveSelectors").onclick = async () => {
  try {
    if (!activeSite) throw new Error("احفظ الموقع أولاً.");
    const d = await api("/api/sites/"+activeSite.id,{method:"PUT",body:JSON.stringify(sitePayload())});
    activeSite=d.site; await loadSites(); $("siteSelect").value=activeSite.id;
    setStatus("sessionStatus","تم حفظ محددات عناصر التوليد لهذا الموقع.","good");
  } catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
async function fileAsBase64(file) {
  if (!file) return "";
  if (file.size > 14*1024*1024) throw new Error("حجم الصورة يتجاوز 14 ميغابايت.");
  return await new Promise((resolve,reject)=>{
    const reader=new FileReader(); reader.onload=()=>resolve(String(reader.result).split(",")[1]||"");
    reader.onerror=()=>reject(new Error("تعذر قراءة الصورة.")); reader.readAsDataURL(file);
  });
}
async function pollJob(id) {
  for (;;) {
    const d = await api("/api/jobs/"+id);
    setStatus("jobStatus","الحالة: "+d.status+"\nالمرحلة: "+d.stage+(d.error?"\n"+d.error:""),d.status==="failed"?"bad":d.status==="completed"?"good":"");
    if (d.status==="completed") {
      const link=document.createElement("button"); link.className="primary"; link.textContent="تنزيل الفيديو: "+d.result.filename;
      link.onclick=async()=>{
        try { const response=await fetch(d.result.downloadUrl,{headers:{Authorization:"Bearer "+getToken()}}); if(!response.ok) throw new Error("تعذر تنزيل الملف.");
          const blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=d.result.filename;a.click();URL.revokeObjectURL(url);
        } catch(e){setStatus("jobStatus",e.message,"bad");}
      };
      $("downloadArea").replaceChildren(link); return;
    }
    if (d.status==="failed") return;
    await new Promise(resolve=>setTimeout(resolve,4000));
  }
}
$("generate").onclick = async () => {
  try {
    if (!activeSite) throw new Error("اختر موقعاً أولاً.");
    const prompt=$("prompt").value.trim(); if(!prompt) throw new Error("اكتب وصف الفيديو.");
    const file=$("reference").files[0];
    const imageBase64=await fileAsBase64(file);
    $("downloadArea").replaceChildren();
    setStatus("jobStatus","تم إرسال المهمة إلى الوكيل...","");
    const d=await api("/api/generate",{method:"POST",body:JSON.stringify({siteId:activeSite.id,prompt,imageBase64,imageName:file?.name||""})});
    await pollJob(d.jobId);
  } catch(e) { setStatus("jobStatus",e.message,"bad"); }
};
connect().catch(()=>{});
