import { initializeTaskStore } from "./task-store.js";
import { createVideoWorker } from "./video-worker.js";

const worker = createVideoWorker();

if (process.argv.includes("--once")) {
  await initializeTaskStore();
  const result = await worker.runOnce();
  console.log("JoyVerse worker one-shot result:", JSON.stringify(result));
  if (result.status === "failed") process.exitCode = 1;
} else {
  process.once("SIGINT", () => worker.stop());
  process.once("SIGTERM", () => worker.stop());
  await worker.run();
}
