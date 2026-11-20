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
from decimal import Decimal, InvalidOperation
from urllib.parse import urlencode, quote

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


# ---------------------------------------------------------------------------
# 4. CRC-20 / LEAF（Bitcoin L1 token ledger）
# ---------------------------------------------------------------------------
CRC20_BASE = "https://crc20.org/api/v1"


def _decimal_string(value):
    """安全解析协议中的十进制字符串；金额不使用 binary float。"""
    if value is None:
        return None
    try:
        number = Decimal(str(value))
        if not number.is_finite():
            return None
        return number
    except (InvalidOperation, ValueError, TypeError):
        return None


def _sat_per_leaf_to_usd(unit_price_sat, btc_usdt):
    """把 sat/LEAF 按当前 BTC/USDT 参考价换算；结果是派生估值，不是交易所成交价。"""
    sats = _decimal_string(unit_price_sat)
    btc_price = _decimal_string(btc_usdt)
    if sats is None or btc_price is None or btc_price <= 0:
        return None
    return format((sats * btc_price / Decimal(100000000)).normalize(), "f")


def fetch_crc20_status():
    """读取 CRC-20 indexer 状态；synced=false 时不得把 404 当成链上不存在。"""
    try:
        data = _get_json(f"{CRC20_BASE}/status")
        return {
            "ok": isinstance(data, dict),
            "source": "crc20.org/api/v1/status",
            "data": data if isinstance(data, dict) else None,
            "ts": int(time.time() * 1000),
        }
    except Exception as exc:
        return {"ok": False, "source": "crc20.org/api/v1/status", "reason": str(exc)}


def fetch_crc20_stats(tick="LEAF", api_key=None):
    """读取 LEAF/AXBT 统计；原始 token amounts 保留字符串，调用方应使用 Decimal/BigInt。"""
    tick = str(tick or "LEAF").upper()
    if tick not in ("LEAF", "AXBT"):
        return {"ok": False, "reason": "tick must be LEAF or AXBT"}
    try:
        headers = {"X-API-Key": api_key} if api_key else None
        data = _get_json(f"{CRC20_BASE}/stats/{tick}", extra_headers=headers)
        return {
            "ok": isinstance(data, dict),
            "source": f"crc20.org/api/v1/stats/{tick}",
            "data": data if isinstance(data, dict) else None,
            "ts": int(time.time() * 1000),
        }
    except Exception as exc:
        return {"ok": False, "source": f"crc20.org/api/v1/stats/{tick}", "reason": str(exc)}


def fetch_crc20_history(limit=100, cursor=None, tick="LEAF", api_key=None):
    """读取全局已确认操作；cursor 必须原样传回，建议按 30–60 秒节奏轮询第一页。"""
    tick = str(tick or "LEAF").upper()
    if tick not in ("LEAF", "AXBT", "ALL"):
        return {"ok": False, "reason": "tick must be LEAF, AXBT or all"}
    try:
        limit = max(1, min(100, int(limit)))
        params = {"limit": limit, "tick": tick.lower() if tick == "ALL" else tick}
        if cursor:
            params["cursor"] = str(cursor)
        headers = {"X-API-Key": api_key} if api_key else None
        data = _get_json(f"{CRC20_BASE}/history?{urlencode(params)}", extra_headers=headers)
        return {
            "ok": isinstance(data, dict),
            "source": "crc20.org/api/v1/history",
            "data": data if isinstance(data, dict) else None,
            "ts": int(time.time() * 1000),
        }
    except Exception as exc:
        return {"ok": False, "source": "crc20.org/api/v1/history", "reason": str(exc)}


def fetch_crc20_transaction(txid, tick="LEAF", api_key=None):
    """读取一笔已确认交易的 CRC-20 解析；404/503 由调用方区分处理。"""
    txid = str(txid or "").lower()
    if len(txid) != 64 or any(ch not in "0123456789abcdef" for ch in txid):
        return {"ok": False, "reason": "txid must be 64 hexadecimal characters"}
    tick = str(tick or "LEAF").upper()
    if tick not in ("LEAF", "AXBT", "ALL"):
        return {"ok": False, "reason": "tick must be LEAF, AXBT or all"}
    try:
        headers = {"X-API-Key": api_key} if api_key else None
        suffix = f"?tick={tick.lower() if tick == 'ALL' else tick}"
        data = _get_json(f"{CRC20_BASE}/transactions/{quote(txid)}{suffix}", extra_headers=headers)
        return {
            "ok": isinstance(data, dict),
            "source": "crc20.org/api/v1/transactions",
            "data": data if isinstance(data, dict) else None,
            "ts": int(time.time() * 1000),
        }
    except Exception as exc:
        return {"ok": False, "source": "crc20.org/api/v1/transactions", "reason": str(exc)}


def fetch_crc20_market_snapshot(btc_usdt=None, history_limit=100):
    """
    汇总 LEAF 的 indexer status、token stats、global history。
    严格区分 marketplace sale 与 AXBT/LEAF pool swap；不把两者混成单一 latest_trade。
    CRC-20 API 没有公开 best bid/ask order book，因此 bid/ask 与 6h VWAP 保持 unknown。
    """
    status = fetch_crc20_status()
    stats = fetch_crc20_stats("LEAF")
    history = fetch_crc20_history(limit=history_limit, tick="LEAF")
    stat_data = stats.get("data") or {}
    token = stat_data.get("token") or {}
    market = stat_data.get("market") or {}
    pool = stat_data.get("pool") or {}
    pool_last = pool.get("last") or {}

    market_sale_sat = market.get("last_unit_price_sat")
    leaf_atoms = _decimal_string(pool_last.get("leaf"))
    axbt_atoms = _decimal_string(pool_last.get("axbt"))
    pool_swap_sat = None
    if leaf_atoms is not None and leaf_atoms > 0 and axbt_atoms is not None and axbt_atoms >= 0:
        # LEAF atoms = 1e-8 LEAF; AXBT atoms = satoshis.
        pool_swap_sat = format((axbt_atoms * Decimal(100000000) / leaf_atoms).normalize(), "f")

    status_data = status.get("data") or {}
    synced = status_data.get("synced") is True
    status_height = status_data.get("height")
    stats_height = token.get("height")
    height_consistent = (
        isinstance(status_height, int) and isinstance(stats_height, int)
        and stats_height == status_height
    )

    return {
        "ok": bool(status.get("ok") and stats.get("ok") and history.get("ok")),
        "source": "crc20.org/api/v1",
        "receivedAt": int(time.time() * 1000),
        "indexer": {
            "synced": synced,
            "height": status_height,
            "statsHeight": stats_height,
            "heightConsistent": height_consistent,
        },
        "token": {
            "tick": "LEAF",
            "decimals": 8,
            "supplyAtoms": token.get("supply"),
            "holders": token.get("holders"),
        },
        "marketplace": {
            "lastSaleUnitPriceSat": str(market_sale_sat) if market_sale_sat is not None else None,
            "lastSaleUsdDerived": _sat_per_leaf_to_usd(market_sale_sat, btc_usdt),
            "lastSale": market.get("last"),
            "sales": market.get("sales"),
            "volumeSat": market.get("volume_sat"),
        },
        "pool": {
            "swaps": pool.get("swaps"),
            "last": pool_last or None,
            "lastSwapUnitPriceSatDerived": pool_swap_sat,
        },
        "priceQuality": {
            "latestTradeUsd": None,
            "recentVwap6hUsd": None,
            "bestBidUsd": None,
            "bestAskUsd": None,
            "note": "API 当前提供 marketplace last sale 与 pool last swap 的分离字段；没有可公开读取的完整订单簿。未从历史价格/Floor 推算 bid/ask 或 6h VWAP。",
        },
        "history": history.get("data"),
        "raw": {
            "status": status.get("data"),
            "stats": stat_data,
        },
        "trust": {
            "indexerSynced": synced,
            "statsHeightConsistent": height_consistent,
            "confirmedLedgerOnly": True,
            "btcUsdtReference": str(btc_usdt) if btc_usdt is not None else None,
        },
        "errors": {
            "status": status.get("reason"),
            "stats": stats.get("reason"),
            "history": history.get("reason"),
        },
    }
