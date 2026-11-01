import { handleAiChat } from "../../_lib/ai-core.mjs";

export async function onRequest({ request }) {
  return handleAiChat(request);
}
