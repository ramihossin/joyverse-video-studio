import { Client } from "@gradio/client";

const spaces = [
  "Pika-Labs/pika-h3-flex",
  "vamo455/Omni-videos-custom-auto_prompt_high-quality"
];

for (const space of spaces) {
  console.log("\\n=== SPACE " + space + " ===");
  try {
    const client = await Client.connect(space);
    const api = await client.view_api();
    console.log(JSON.stringify(api, null, 2).slice(0, 18000));
  } catch (error) {
    console.log("SPACE_ERROR", String(error?.stack || error).slice(0, 5000));
  }
}
