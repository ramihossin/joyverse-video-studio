export const MANIFEST_SCHEMA = "joyverse-scene-manifest";
export const MAX_MANIFEST_SCENES = 100;
const MAX_TITLE_LENGTH = 100;
const MAX_PROMPT_LENGTH = 4000;

export function parseManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ملف الإنتاج يجب أن يحتوي على كائن JSON.");
  }
  if (value.schema !== MANIFEST_SCHEMA || value.version !== 1) {
    throw new Error("صيغة الملف غير مدعومة. المطلوب JoyVerse Scene Manifest الإصدار 1.");
  }
  if (!Array.isArray(value.scenes) || value.scenes.length < 1 || value.scenes.length > MAX_MANIFEST_SCENES) {
    throw new Error("يجب أن يحتوي الملف على مشهد واحد إلى 100 مشهد.");
  }

  return value.scenes.map((scene, index) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      throw new Error(`بيانات المشهد ${index + 1} غير صالحة.`);
    }
    const title = typeof scene.title === "string" ? scene.title.trim() : "";
    const prompt = typeof scene.prompt === "string" ? scene.prompt.trim() : "";
    if (!title || title.length > MAX_TITLE_LENGTH) {
      throw new Error(`عنوان المشهد ${index + 1} مطلوب، وبحد أقصى 100 حرف.`);
    }
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      throw new Error(`وصف المشهد ${index + 1} مطلوب، وبحد أقصى 4000 حرف.`);
    }
    return { title, prompt };
  });
}

export function serializeManifest(queue) {
  const scenes = (Array.isArray(queue) ? queue : [])
    .filter(scene => scene && typeof scene.title === "string" && typeof scene.prompt === "string")
    .map(scene => ({ title: scene.title, prompt: scene.prompt }));
  return JSON.stringify({ schema: MANIFEST_SCHEMA, version: 1, scenes }, null, 2);
}
