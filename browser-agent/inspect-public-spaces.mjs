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
    const summary = Object.entries(api.named_endpoints || {}).map(([name, endpoint]) => ({
      name,
      parameters: (endpoint.parameters || []).map(p => ({
        name: p.parameter_name,
        label: p.label,
        type: p.python_type?.type || p.type,
        default: p.parameter_default,
        hasDefault: p.parameter_has_default
      })),
      returns: (endpoint.returns || []).map(r => ({
        label: r.label, type: r.python_type?.type || r.type, component: r.component
      }))
    }));
    console.log(JSON.stringify(summary, null, 2));
    console.log("UNNAMED_ENDPOINTS", JSON.stringify(api.unnamed_endpoints || [], null, 2));
  } catch (error) {
    console.log("SPACE_ERROR", String(error?.stack || error).slice(0, 5000));
  }
}
