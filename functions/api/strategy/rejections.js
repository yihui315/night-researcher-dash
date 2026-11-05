import { handleRiskRejections } from "../../_lib/strategy-registry.mjs";

export async function onRequest({ request, env }) {
  return handleRiskRejections(request, env);
}
