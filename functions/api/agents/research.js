import { handleAgentResearch } from "../../_lib/agent-orchestrator.mjs";

export async function onRequest({ request, env }) {
  return handleAgentResearch(request, undefined, env);
}
