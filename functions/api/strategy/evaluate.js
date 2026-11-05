import { handleStrategyEvaluate } from "../../_lib/strategy-registry.mjs";

export async function onRequest({ request, env }) {
  return handleStrategyEvaluate(request, env);
}
