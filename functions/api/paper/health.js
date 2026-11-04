import { handlePaperHealth } from "../../_lib/paper-health.mjs";

export async function onRequest({ request, env }) {
  return handlePaperHealth(request, env);
}
