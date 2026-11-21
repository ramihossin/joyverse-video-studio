const $ = id => document.getElementById(id);
let activeSite = null;
let sites = [];
let remoteViewport = { width: 1280, height: 720 };
let screenInteractionQueue = Promise.resolve();
let screenPointer = null;
let screenRefreshPromise = null;
const screenStage = $("screenStage");
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
  $("sitePurpose").value = site?.purpose || "video";
  $("baseUrl").value = site?.baseUrl || "";
  $("loginUrl").value = site?.loginUrl || "";
  const baseHost = site?.baseUrl ? new URL(site.baseUrl).hostname : "";
  $("allowedHosts").value = (site?.allowedHosts || []).filter(h => h !== baseHost).join(", ");
  for (const key of ["promptSelector","uploadSelector","generateSelector","readySelector","downloadSelector"]) {
    $(key).value = site?.selectors?.[key] || "";
  }
  $("waitSeconds").value = site?.waitSeconds || 300;
  const isDirectory = site?.purpose === "directory";
  $("generate").disabled = isDirectory;
  $("generate").title = isDirectory ? "هذا الموقع دليل لاكتشاف الأدوات وليس مولداً للفيديو." : "";
  const providerHint = site?.id === "loremotion-free-video"
    ? "LoreMotion: ابدأ من صفحة التوليد مباشرة؛ أول فيديو متاح دون تسجيل حساب."
    : site?.id === "pavo-ai-video"
      ? "Pavo AI: استخدم التسجيل أو الدخول بالبريد الإلكتروني؛ لا تستخدم Google داخل المتصفح البعيد."
      : "";
  setStatus("sessionStatus", site ? (isDirectory
    ? "هذا ملف دليل لاكتشاف أدوات الذكاء الاصطناعي؛ لا تُرسل إليه مهام توليد الفيديو."
    : ((site.hasSavedSession ? "توجد جلسة دخول محفوظة ومشفّرة لهذا الموقع." : "لا توجد جلسة محفوظة.") + (providerHint ? "\n" + providerHint : ""))) : "أضف موقعاً أو اختر موقعاً محفوظاً.");
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
    name: $("siteName").value.trim(), purpose: $("sitePurpose").value, baseUrl: $("baseUrl").value.trim(),
    loginUrl: $("loginUrl").value.trim(), allowedHosts: $("allowedHosts").value.split(",").map(x=>x.trim()).filter(Boolean),
    selectors: selectorData(), waitSeconds: Number($("waitSeconds").value || 300)
  };
}
async function connect() {
  sessionStorage.setItem(tokenKey, getToken());
  const health = await api("/health");
  await loadSites();
  const rss = health.memoryMiB?.rss;
  setStatus("connection", Number.isFinite(rss) ? `متصل بالخدمة · الذاكرة ${rss} MiB` : "متصل بالخدمة", "good");
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
function renderScreen(d) {
  remoteViewport = {
    width: Number(d.width) > 0 ? Number(d.width) : 1280,
    height: Number(d.height) > 0 ? Number(d.height) : 720
  };
  if (d.imageBase64) $("screen").src = "data:image/jpeg;base64," + d.imageBase64;
}
async function refreshScreen() {
  if (screenRefreshPromise) return screenRefreshPromise;
  screenRefreshPromise = (async () => {
    const d = await api("/api/browser/screenshot", { method:"GET" });
    renderScreen(d);
    return d;
  })();
  try { return await screenRefreshPromise; }
  finally { screenRefreshPromise = null; }
}
function mapScreenPoint(clientX, clientY) {
  const rect = screenStage.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / remoteViewport.width, rect.height / remoteViewport.height);
  const shownWidth = remoteViewport.width * scale;
  const shownHeight = remoteViewport.height * scale;
  const offsetX = (rect.width - shownWidth) / 2;
  const offsetY = (rect.height - shownHeight) / 2;
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  if (localX < offsetX || localY < offsetY ||
      localX > offsetX + shownWidth || localY > offsetY + shownHeight) return null;
  return {
    x: Math.max(0, Math.min(remoteViewport.width, Math.round((localX - offsetX) / scale))),
    y: Math.max(0, Math.min(remoteViewport.height, Math.round((localY - offsetY) / scale)))
  };
}
function queueScreenInteraction(payload) {
  const task = screenInteractionQueue.then(async () => {
    const d = await api("/api/browser/gesture", {
      method:"POST",
      body:JSON.stringify(payload)
    });
    setStatus("sessionStatus", "تم تنفيذ التفاعل؛ جارٍ تحديث المعاينة...", "good");
    // Refresh independently: slow screenshots must never delay the next tap.
    setTimeout(() => refreshScreen().catch(error => {
      setStatus("sessionStatus", "تم التفاعل، لكن تعذّر تحديث المعاينة: " + error.message, "bad");
    }), 120);
  });
  screenInteractionQueue = task.catch(error => {
    setStatus("sessionStatus", error.message, "bad");
  });
  return task;
}
if (screenStage) {
  screenStage.addEventListener("contextmenu", event => event.preventDefault());
  screenStage.addEventListener("dragstart", event => event.preventDefault());
  screenStage.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = mapScreenPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    screenPointer = {
      pointerId: event.pointerId,
      start: point,
      last: point,
      points: [point],
      moved: false
    };
    try { screenStage.setPointerCapture(event.pointerId); } catch {}
  });
  screenStage.addEventListener("pointermove", event => {
    if (!screenPointer || screenPointer.pointerId !== event.pointerId) return;
    const point = mapScreenPoint(event.clientX, event.clientY);
    if (!point) return;
    const distanceFromStart = Math.hypot(point.x - screenPointer.start.x, point.y - screenPointer.start.y);
    if (distanceFromStart > 9) screenPointer.moved = true;
    const last = screenPointer.points[screenPointer.points.length - 1];
    if (Math.hypot(point.x - last.x, point.y - last.y) >= 5 && screenPointer.points.length < 31) {
      screenPointer.points.push(point);
    }
    screenPointer.last = point;
  });
  screenStage.addEventListener("pointerup", event => {
    if (!screenPointer || screenPointer.pointerId !== event.pointerId) return;
    const state = screenPointer;
    screenPointer = null;
    try { screenStage.releasePointerCapture(event.pointerId); } catch {}
    const end = mapScreenPoint(event.clientX, event.clientY) || state.last;
    const distance = Math.hypot(end.x - state.start.x, end.y - state.start.y);
    if (state.moved && distance > 9) {
      const points = state.points.slice(0, 31);
      const last = points[points.length - 1];
      if (last.x !== end.x || last.y !== end.y) points.push(end);
      void queueScreenInteraction({ action:"swipe", points }).catch(() => {});
    } else {
      void queueScreenInteraction({ action:"tap", x:end.x, y:end.y }).catch(() => {});
    }
  });
  screenStage.addEventListener("pointercancel", () => { screenPointer = null; });
}
async function actAndRender(path, body) {
  const d = await api(path, { method:"POST", body:JSON.stringify(body) });
  if (d.imageBase64) renderScreen(d);
  else await refreshScreen();
  return d;
}
$("openSite").onclick = async () => {
  try {
    if (!activeSite) throw new Error("اختر أو احفظ موقعاً أولاً.");
    setStatus("sessionStatus", "جارٍ فتح الموقع واستقبال محتواه...", "");
    const result = await api("/api/sites/" + activeSite.id + "/open", { method:"POST", body:"{}" });
    const nav = result.navigation || {};
    const loadMessage = nav.domContentLoaded
      ? "اكتمل تحميل بنية الصفحة."
      : "عُرضت الصفحة جزئياً؛ قد تظل بعض العناصر قيد التحميل.";
    setStatus("sessionStatus", "تم فتح " + (result.title || "الموقع") + "\n" + result.url + "\n" + loadMessage + "\n" + (result.sessionRestored ? "استعيدت الجلسة المحفوظة." : "أكمل تسجيل الدخول بنفسك عند الحاجة ثم احفظ الجلسة."), nav.domContentLoaded ? "good" : "");
    await refreshScreen();
    setTimeout(() => refreshScreen().catch(() => {}), 3500);
  } catch(e) {
    // A navigation can time out after the remote page has already appeared.
    // Refresh the preview before reporting the error so a partial page is not hidden.
    await refreshScreen().catch(() => {});
    setStatus("sessionStatus", e.message, "bad");
  }
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
$("recoverBrowser").onclick = async () => {
  if (!confirm("سيتم إيقاف العملية الحالية وإعادة تشغيل المتصفح. أي تغييرات لم تحفظها قد تضيع. متابعة؟")) return;
  try {
    const result = await api("/api/browser/recover",{method:"POST",body:"{}"});
    $("screen").removeAttribute("src");
    setStatus("sessionStatus",result.message,"good");
  } catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
$("scrollUp").onclick = () => actAndRender("/api/browser/scroll",{deltaY:-650}).catch(e=>setStatus("sessionStatus",e.message,"bad"));
$("scrollDown").onclick = () => actAndRender("/api/browser/scroll",{deltaY:650}).catch(e=>setStatus("sessionStatus",e.message,"bad"));
$("sendText").onclick = async () => {
  try {
    const text=$("typing").value;
    await actAndRender("/api/browser/type",{text});
    $("typing").value="";
  } catch(e) { setStatus("sessionStatus",e.message,"bad"); }
};
$("pressEnter").onclick = () => actAndRender("/api/browser/key",{key:"Enter"}).catch(e=>setStatus("sessionStatus",e.message,"bad"));
$("pressTab").onclick = () => actAndRender("/api/browser/key",{key:"Tab"}).catch(e=>setStatus("sessionStatus",e.message,"bad"));
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
    const report = [
      "عنوان الصفحة: " + (d.title || "لم يظهر عنوان بعد"),
      "عناصر قابلة للاستخدام: " + candidates.length,
      "إطارات الصفحة: " + (d.frames?.length || 0),
      "حالة التحميل: " + (d.navigation?.domContentLoaded ? "اكتمل" : "جزئي أو ما زال جارياً")
    ];
    if (d.verification?.detected) report.push("توجد مؤشرات على خطوة تحقق أمنية. أكملها يدوياً داخل معاينة الصفحة؛ لا يمكن للوكيل تجاوزها.");
    if (d.googleAuthBlocked) report.push("Google رفض تسجيل الدخول لأن المتصفح خاضع للتحكم الآلي. لا تعاود محاولة Google هنا؛ استخدم البريد الإلكتروني إن كان الموقع يتيحه. في LoreMotion لا تحتاج إلى تسجيل حساب لأول توليد.");
    if (d.issues?.length) {
      report.push("ملاحظات أخطاء التحميل الأخيرة: " + d.issues.length);
      for (const issue of d.issues.slice(-6)) {
        report.push("• " + issue.type + (issue.status ? " " + issue.status : "") + (issue.url ? " — " + issue.url : "") + (issue.message ? " — " + issue.message : ""));
      }
    } else {
      report.push("لم تُسجل أخطاء شبكة أو JavaScript حتى الآن.");
    }
    setStatus("sessionStatus", report.join("\n"), d.verification?.detected || d.issues?.length ? "" : "good");
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
    if (activeSite.purpose === "directory") throw new Error("هذا الموقع دليل لاكتشاف الأدوات، وليس مولداً للفيديو.");
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
