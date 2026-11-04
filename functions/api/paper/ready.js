import { handlePaperReady } from "../../_lib/paper-health.mjs";

export async function onRequest({ request, env }) {
  return handlePaperReady(request, env);
}
