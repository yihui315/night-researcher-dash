# -*- coding: utf-8 -*-
"""
connectors_extra.py —— RUNES / 永续资金费率 / 爆仓 连接器
========================================================
设计原则（与全局硬约束一致）：
  - 全部 try/except + 超时包裹；任何失败一律返回结构化「未知」，绝不虚构数据。
  - 在「可访问环境」（能直连交易所/数据商）或设置了对应 API key 后，这些函数即可真实取数；
    本环境（仅放行 Binance 镜像 / DefiLlama / alternative.me / mempool.space）下必然降级为未知。

所需环境变量（可选）：
  COINGLASS_API_KEY  : 爆仓/清算聚合（open-api.coinglass.com）
  UNISAT_API_KEY     : RUNES 代币榜（open-api.unisat.io）
  DUNE_API_KEY       : RUNES/Dune 查询（api.dune.com，需配合具体 query_id）

⚠️ 本文件只做「数据接入」，不写下单代码、不给买卖建议。
"""
import os
import json
import time
import urllib.request
import urllib.error

TIMEOUT = 15
_UA = {"User-Agent": "Mozilla/5.0 (night-researcher)"}


def _get_json(url, apikey=None, extra_headers=None):
    headers = dict(_UA)
    if extra_headers:
        headers.update(extra_headers)
    if apikey:
        headers["Authorization"] = apikey if apikey.startswith("Bearer ") else f"Bearer {apikey}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# 1. 永续资金费率（funding rate）
# ---------------------------------------------------------------------------
def fetch_funding_rate(symbol="BTCUSDT"):
    """优先 Bybit，回退 Binance fapi。返回 {ok, rate, source, ts} 或 {ok:False, reason}。"""
    # 演示模式：不触网即预览「已获取」渲染格式（非真实数据，仅用于查看早报排版）
    if os.environ.get("NR_DEMO"):
        return {"ok": True, "rate": 0.0001, "source": "DEMO(格式预览·非真实)",
                "ts": int(time.time() * 1000), "demo": True}
    # Bybit
    try:
        url = f"https://api.bybit.com/v5/market/tickers?category=linear&symbol={symbol}"
        d = _get_json(url)
        if d.get("retCode") == 0:
            lst = (d.get("result") or {}).get("list") or []
            if lst and "fundingRate" in lst[0]:
                return {"ok": True, "rate": float(lst[0]["fundingRate"]),
                        "source": "Bybit", "ts": int(time.time() * 1000)}
    except Exception:
        pass
    # Binance fapi（主站在本环境被墙；可访问环境可用）
    try:
        url = f"https://fapi.binance.com/fapi/v1/premiumIndex?symbol={symbol}"
        d = _get_json(url)
        if "lastFundingRate" in d:
            return {"ok": True, "rate": float(d["lastFundingRate"]),
                    "source": "Binance", "ts": int(time.time() * 1000)}
    except Exception:
        pass
    return {"ok": False,
            "reason": "Bybit/Binance 资金费率接口在本环境不可达（需可访问网络；主站 fapi 被墙，Bybit 亦被墙）"}


# ---------------------------------------------------------------------------
# 2. 爆仓 / 强平数据（liquidations）
# ---------------------------------------------------------------------------
def fetch_liquidations(symbol="BTCUSDT"):
    """需 CoinGlass API key 或可达的 Binance allForceOrders。
    返回 {ok, source, ...} 或 {ok:False, reason}。"""
    if os.environ.get("NR_DEMO"):
        return {"ok": True, "source": "DEMO(格式预览·非真实)", "count": 128,
                "ts": int(time.time() * 1000), "demo": True}
    key = os.environ.get("COINGLASS_API_KEY")
    if key:
        try:
            url = (f"https://open-api.coinglass.com/api/pro/v1/futures/"
                   f"liquidation_chart?symbol={symbol}&timeType=0")
            d = _get_json(url, apikey=key)
            if d.get("code") == "0" or d.get("success"):
                return {"ok": True, "source": "CoinGlass", "data": d,
                        "ts": int(time.time() * 1000)}
        except Exception:
            pass
    # Binance allForceOrders（历史有限，需可达）
    try:
        url = f"https://fapi.binance.com/fapi/v1/allForceOrders?symbol={symbol}&limit=100"
        d = _get_json(url)
        if isinstance(d, list) and d:
            return {"ok": True, "source": "Binance", "count": len(d),
                    "ts": int(time.time() * 1000)}
    except Exception:
        pass
    return {"ok": False,
            "reason": "爆仓数据需 CoinGlass API key（COINGLASS_API_KEY）或可达的 Binance fapi；本环境不可达"}


# ---------------------------------------------------------------------------
# 3. RUNES 代币榜（市值 / 价格 / 成交量）
# ---------------------------------------------------------------------------
def fetch_runes_top(limit=20):
    """需 UniSat(UNISAT_API_KEY) 或 Dune(DUNE_API_KEY) API key。
    返回 {ok, source, tokens, ts} 或 {ok:False, reason}。
    注：runealpha / ordinals / magisat 等公开源在本环境均被 Cloudflare 拦截，故主走 key 路径。"""
    if os.environ.get("NR_DEMO"):
        demo_tokens = [
            {"name": "DOG•GO•TO•THE•MOON", "symbol": "DOG", "priceUsd": 0.0031,
             "volume24h": 182000, "mcap": 6400000},
            {"name": "RSIC•GENESIS•RUNE", "symbol": "RSIC", "priceUsd": 0.012,
             "volume24h": 91000, "mcap": 3100000},
        ][:limit]
        return {"ok": True, "source": "DEMO(格式预览·非真实)", "tokens": demo_tokens,
                "ts": int(time.time() * 1000), "demo": True}
    unisat = os.environ.get("UNISAT_API_KEY")
    if unisat:
        try:
            url = f"https://open-api.unisat.io/v3/market/runes/tokens?limit={limit}"
            d = _get_json(url, apikey=unisat)
            if d.get("code") == 0 and "data" in d:
                return {"ok": True, "source": "UniSat", "tokens": d["data"],
                        "ts": int(time.time() * 1000)}
        except Exception:
            pass
    dune = os.environ.get("DUNE_API_KEY")
    if dune:
        try:
            # Dune 需具体 query_id；此处为接入骨架，<QUERY_ID> 由使用者替换
            query_id = os.environ.get("DUNE_RUNES_QUERY_ID", "<QUERY_ID>")
            url = f"https://api.dune.com/api/v1/query/{query_id}/results"
            d = _get_json(url, apikey=dune)
            if "result" in d:
                return {"ok": True, "source": "Dune", "data": d["result"],
                        "ts": int(time.time() * 1000)}
        except Exception:
            pass
    return {"ok": False,
            "reason": ("RUNES 代币数据需 UniSat(UNISAT_API_KEY) 或 Dune(DUNE_API_KEY + DUNE_RUNES_QUERY_ID) "
                       "API key；本环境 runealpha/ordinals 等源均被 Cloudflare 拦截，不可达")}


if __name__ == "__main__":
    # 自检：本环境下应全部优雅降级为未知
    print("funding :", fetch_funding_rate("BTCUSDT"))
    print("liq     :", fetch_liquidations("BTCUSDT"))
    print("runes   :", fetch_runes_top(20))
