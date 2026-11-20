export type TradingSide = "BUY" | "SELL";
export type PaperOrderType = "MARKET" | "LIMIT";
export interface TradingApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}
export interface MarketSnapshotParams {
  symbols?: string[];
  interval?: "1m" | "15m" | "1h" | "4h" | "1d";
}
export interface PaperOrderInput {
  symbol: string;
  side: TradingSide;
  type: PaperOrderType;
  quantity: number;
  limitPrice?: number;
  confirmationId: string;
  researchRunId?: string;
}
export class TradingApiError extends Error {
  status: number;
  code: string | null;
  requestId: string | null;
}
export function createTradingApi(options?: TradingApiOptions): {
  getProviderHealth(): Promise<Record<string, unknown>>;
  listProviders(): Promise<Record<string, unknown>>;
  probeProvider(providerId: string): Promise<Record<string, unknown>>;
  listProviderModels(providerId: string): Promise<Record<string, unknown>>;
  getHealth(): Promise<Record<string, unknown>>;
  getMarketSnapshot(params?: MarketSnapshotParams): Promise<Record<string, unknown>>;
  getOrderBook(input: { venue?: string; symbol: string }): Promise<Record<string, unknown>>;
  createResearchRun(input: { providerId: string; modelOverride?: string; symbols: string[]; snapshotId?: string; strategyVersion?: string }): Promise<{ runId: string; status: string; autoExecution: false }>;
  getResearchRun(runId: string): Promise<Record<string, unknown>>;
  listStrategies(): Promise<Record<string, unknown>>;
  getPaperAccount(): Promise<Record<string, unknown>>;
  createPaperOrder(input: PaperOrderInput): Promise<Record<string, unknown>>;
  cancelPaperOrder(orderId: string): Promise<Record<string, unknown>>;
  subscribeEvents(options?: { after?: string }): EventSource;
};
