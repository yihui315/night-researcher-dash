import { handleAgentResearch } from "../../_lib/agent-orchestrator.mjs";

export async function onRequest({ request }) {
  return handleAgentResearch(request);
}
