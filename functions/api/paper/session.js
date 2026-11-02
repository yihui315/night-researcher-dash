import { handlePaperSession } from "../../_lib/paper-ledger.mjs";

export async function onRequest({ request, env }) {
  return handlePaperSession(request, env);
}
