import { handlePaperMarketTick } from "../../../_lib/paper-server.mjs";

export async function onRequest({ request, env }) {
  return handlePaperMarketTick(request, env);
}
