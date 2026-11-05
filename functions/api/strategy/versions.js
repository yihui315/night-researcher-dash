import { handleStrategyVersions } from "../../_lib/strategy-registry.mjs";

export async function onRequest({ request, env }) {
  return handleStrategyVersions(request, env);
}
