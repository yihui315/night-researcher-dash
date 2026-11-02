import { handlePaperOrders } from "../../_lib/paper-server.mjs";

export async function onRequest({ request, env }) {
  return handlePaperOrders(request, env);
}
