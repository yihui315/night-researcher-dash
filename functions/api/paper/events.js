import { handlePaperServerEvents } from "../../_lib/paper-server.mjs";

export async function onRequest({ request, env }) {
  return handlePaperServerEvents(request, env);
}
