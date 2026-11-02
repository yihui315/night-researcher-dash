import { handlePaperAccount } from "../../_lib/paper-server.mjs";

export async function onRequest({ request, env }) {
  return handlePaperAccount(request, env);
}
