import { handlePaperReplay } from "../../_lib/paper-server.mjs";

export async function onRequest({ request, env }) {
  return handlePaperReplay(request, env);
}
