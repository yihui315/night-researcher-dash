import { handleResearchRuns } from "../../_lib/strategy-registry.mjs";

export async function onRequest({ request, env }) {
  return handleResearchRuns(request, env);
}
