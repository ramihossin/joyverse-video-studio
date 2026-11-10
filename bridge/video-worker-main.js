import { pathToFileURL } from "node:url";
import { createVideoWorker } from "./video-worker.js";

const worker = createVideoWorker();
process.once("SIGINT", () => worker.stop());
process.once("SIGTERM", () => worker.stop());
await worker.run();
