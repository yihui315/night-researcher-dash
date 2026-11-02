import { handlePaperOrderCancel } from "../../../../_lib/paper-server.mjs";

export async function onRequest({ request, env, params }) {
  return handlePaperOrderCancel(request, env, params.orderId);
}
