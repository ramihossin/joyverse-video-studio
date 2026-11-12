const DIMENSIONS = Object.freeze({
  portrait: Object.freeze({ width: 832, height: 1472 }),
  landscape: Object.freeze({ width: 1472, height: 832 }),
  square: Object.freeze({ width: 512, height: 512 })
});

export function assertVideoOptionsForProvider(options, providerName) {
  if (providerName === "agnes" && (options.duration < 4 || options.duration > 12)) {
    throw new Error("Agnes Video 2.5 Flash supports durations from 4 to 12 seconds.");
  }
  if (providerName === "ltx" && (options.duration < 1 || options.duration > 5)) {
    throw new Error("LTX supports durations from 1 to 5 seconds.");
  }
  if (!["agnes", "ltx"].includes(providerName)) {
    throw new Error("Unsupported video provider.");
  }
  return options;
}

export function normalizeVideoOptions(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("video_options must be an object.");
  }
  const aspect = input.aspect ?? "portrait";
  if (!Object.hasOwn(DIMENSIONS, aspect)) throw new Error("Unsupported video aspect.");
  const duration = input.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 1 || duration > 12) {
    throw new Error("Video duration must be an integer from 1 to 12 seconds.");
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
