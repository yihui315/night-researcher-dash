import { handlePaperLedger } from "../../_lib/paper-ledger.mjs";

export async function onRequest({ request, env }) {
  return handlePaperLedger(request, env);
}
