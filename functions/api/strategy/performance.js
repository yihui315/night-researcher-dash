import { handleStrategyPerformance } from "../../_lib/strategy-registry.mjs";

export async function onRequest({ request, env }) {
  return handleStrategyPerformance(request, env);
}
