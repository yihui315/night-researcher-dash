import { handlePaperAccountReset } from "../../../_lib/paper-server.mjs";

export async function onRequest({ request, env }) {
  return handlePaperAccountReset(request, env);
}
