const DIMENSIONS = Object.freeze({
  portrait: Object.freeze({ width: 832, height: 1472 }),
  landscape: Object.freeze({ width: 1472, height: 832 }),
  square: Object.freeze({ width: 1024, height: 1024 })
});

export function normalizeVideoOptions(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("video_options must be an object.");
  }
  const aspect = input.aspect ?? "portrait";
  if (!Object.hasOwn(DIMENSIONS, aspect)) throw new Error("Unsupported video aspect.");
  const duration = input.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 1 || duration > 5) {
    throw new Error("Video duration must be an integer from 1 to 5 seconds.");
  }
  const seed = input.seed ?? 42;
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) {
    throw new Error("Video seed must be an integer from 0 to 2147483647.");
  }
  for (const key of ["randomize_seed", "enhance_prompt"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      throw new Error(key + " must be a boolean.");
    }
  }
  return Object.freeze({
    aspect,
    ...DIMENSIONS[aspect],
    duration,
    seed,
    randomize_seed: input.randomize_seed ?? false,
    enhance_prompt: input.enhance_prompt ?? false,
    decoder: "conv",
    auto_len: false
  });
}
