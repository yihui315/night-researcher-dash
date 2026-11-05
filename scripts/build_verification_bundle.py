#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JEV V4.3 / §1 - Strategy Verification Runner.

REUSES the repository's real Python quant engine. It does NOT reimplement a
second backtest engine, does NOT use NR_DEMO, and does NOT fabricate metrics:

    backtest_engine.fetch_klines / fetch_fng / Context / simulate /
    evaluate_gates / walk_forward_oos / grid_search / summarize_grid
    strategies.STRATEGIES

Real Binance 4h klines and real Fear & Greed data are fetched over the network.
If data is unavailable the run is marked FAILED (never passed). The output is a
machine-readable, hash-sealed bundle intended to be submitted ONLY by a trusted
GitHub Actions runner through the Trusted Verification API.

The bundle alone grants NOTHING: the server re-validates identity, hashes,
thresholds and result integrity before writing any verified=1 row.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backtest_engine import (  # noqa: E402
    fetch_klines, fetch_fng, Context, simulate, evaluate_gates,
    walk_forward_oos, grid_search, summarize_grid, buy_and_hold_return,
)
from strategies import STRATEGIES  # noqa: E402

# D1 strategy_versions.strategy_id <- Python STRATEGIES registry key.
# The two naming schemes are both REAL; the mapping is explicit and verified
# by the Trusted Verification API before any evidence is persisted.
STRATEGY_ID_MAP = {
    "FNG_EMA_MR": "fng_ema_mean_reversion",
    "BRC20_RSI_MR": "brc20_rsi_mean_reversion",
}
PARAM_GRIDS = {
    "FNG_EMA_MR": {
        "fng_extreme": [20, 25, 30],
        "rsi_entry": [30, 35, 40],
        "max_hold": [10, 20],
    },
    "BRC20_RSI_MR": {
        "oversold": [22, 26, 30, 35, 40],
        "overbought": [60, 65, 70, 75, 80],
    },
}
MIN_SAMPLE_COUNT = 100     # matches functions/_lib/strategy-registry.mjs
MIN_OOS_TRADES = 30        # matches functions/_lib/strategy-registry.mjs
SCHEMA = "jev-verification-bundle/v1"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    return sha256_bytes(path.read_bytes())


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, default=str).encode("utf-8")


def git_head() -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=str(ROOT), stderr=subprocess.DEVNULL
        )
        return out.decode("ascii", "ignore").strip()
    except Exception:
        return ""


def iso(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def build_run(strategy_key: str, symbol: str, args, fng_pts, now_ms: int) -> dict:
    start_ms = now_ms - args.window_days * 86400_000
    oos_ms = now_ms - args.oos_days * 86400_000
    bars = fetch_klines(symbol, args.interval, start_ms, now_ms)
    if len(bars) < 250:
        return {
            "run_id": str(uuid.uuid4()),
            "strategy_id": STRATEGY_ID_MAP[strategy_key],
            "python_strategy_id": strategy_key,
            "strategy_version": "v1",
            "symbol": symbol,
            "interval": args.interval,
            "window_from": iso(start_ms), "window_to": iso(now_ms),
            "data_sources": ["binance-public-klines", "alternative-me-fng"],
            "input_sha256": sha256_bytes(canonical({"bars": bars, "fng": fng_pts, "symbol": symbol})),
            "folds": args.folds,
            "status": "failed",
            "metrics": {"sample_count": 0, "oos_trades": 0, "bars": len(bars)},
            "gates": {"strategy_pass": 0, "oos_pass": 0, "overfit_suspect": 1,
                      "reasons": ["INSUFFICIENT_REAL_KLINES"]},
            "walk_forward": [], "grid": {}
        }

    ctx = Context(bars, fng_pts)
    oos_idx = next((i for i, b in enumerate(bars) if b["t"] >= oos_ms), len(bars) - 1)
    strat = STRATEGIES[strategy_key]()
    summary = simulate(strat, ctx, oos_idx)
    gates, overfit = evaluate_gates(strat, summary, ctx)
    folds = walk_forward_oos(
        STRATEGIES[strategy_key], ctx, PARAM_GRIDS[strategy_key],
        folds=args.folds, oos_days=args.oos_days, min_train_trades=10,
    )
    grid = summarize_grid(grid_search(STRATEGIES[strategy_key], ctx, PARAM_GRIDS[strategy_key], oos_idx))
    buy_hold = buy_and_hold_return(bars)

    ins, oos = summary.get("insample", {}), summary.get("oos", {})
    sample_count = int(summary.get("n_trades") or 0)
    oos_trades = sum(int(fd.get("n") or 0) for fd in folds)
    validated = [fd for fd in folds if fd.get("status") == "VALIDATED"]
    overfit_flag = bool(grid.get("overfit_flag"))
    overfit_suspect = bool(overfit.get("suspect")) or overfit_flag

    reasons: list[str] = []
    if sample_count < MIN_SAMPLE_COUNT:
        reasons.append(f"FULL_SAMPLE_BELOW_{MIN_SAMPLE_COUNT}")
    if not gates.get("g3_robust", {}).get("pass"):
        reasons.append("G3_ROBUSTNESS_FAILED")
    if not gates.get("g4_excess", {}).get("pass"):
        reasons.append("G4_EXCESS_FAILED")
    if float(oos.get("net") or 0) < 0:
        reasons.append("OOS_NET_NEGATIVE")
    if overfit_suspect:
        reasons.append("OVERFIT_SUSPECT")
    if oos_trades < MIN_OOS_TRADES:
        reasons.append(f"OOS_TRADES_BELOW_{MIN_OOS_TRADES}")
    if len(validated) != args.folds:
        reasons.append("WALK_FORWARD_FOLDS_NOT_ALL_VALIDATED")
    if overfit_flag:
        reasons.append("GRID_OVERFIT_FLAG")

    strategy_pass = 1 if not any(r in reasons for r in (
        f"FULL_SAMPLE_BELOW_{MIN_SAMPLE_COUNT}", "G3_ROBUSTNESS_FAILED",
        "G4_EXCESS_FAILED", "OOS_NET_NEGATIVE", "OVERFIT_SUSPECT",
    )) else 0
    oos_pass = 1 if not any(r in reasons for r in (
        f"OOS_TRADES_BELOW_{MIN_OOS_TRADES}", "WALK_FORWARD_FOLDS_NOT_ALL_VALIDATED",
        "GRID_OVERFIT_FLAG", "OVERFIT_SUSPECT", "OOS_NET_NEGATIVE",
    )) else 0

    input_payload = {
        "symbol": symbol, "interval": args.interval,
        "window_from": iso(start_ms), "window_to": iso(now_ms),
        "bars": bars, "fng": fng_pts,
    }
    return {
        "run_id": str(uuid.uuid4()),
        "strategy_id": STRATEGY_ID_MAP[strategy_key],
        "python_strategy_id": strategy_key,
        "strategy_version": "v1",
        "symbol": symbol,
        "interval": args.interval,
        "window_from": iso(start_ms),
        "window_to": iso(now_ms),
        "data_sources": ["binance-public-klines", "alternative-me-fng"],
        "input_sha256": sha256_bytes(canonical(input_payload)),
        "bars": len(bars),
        "folds": args.folds,
        "status": "recorded",
        "execution_model": summary.get("execution_model"),
        "metrics": {
            "sample_count": sample_count,
            "oos_trades": oos_trades,
            "n_trades": sample_count,
            "folds": args.folds,
            "insample": ins,
            "oos": oos,
            "max_drawdown": summary.get("max_drawdown"),
            "win_rate": ins.get("win_rate"),
            "payoff_ratio": ins.get("payoff_ratio"),
            "profit_factor": ins.get("profit_factor"),
            "excess": summary.get("excess"),
            "buy_hold": buy_hold,
            "monte_carlo": summary.get("monte_carlo"),
            "slippage_sensitivity": summary.get("slippage_sensitivity"),
        },
        "gates": {
            "strategy_pass": strategy_pass,
            "oos_pass": oos_pass,
            "overfit_suspect": 1 if overfit_suspect else 0,
            "g3_robust": gates.get("g3_robust"),
            "g4_excess": gates.get("g4_excess"),
            "param_count": overfit.get("param_count"),
            "sensitivity": overfit.get("sensitivity"),
            "reasons": reasons,
        },
        "walk_forward": folds,
        "grid": grid,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Build a REAL, hash-sealed strategy verification bundle")
    ap.add_argument("--window-days", type=int, default=730)
    ap.add_argument("--oos-days", type=int, default=90)
    ap.add_argument("--folds", type=int, default=3)
    ap.add_argument("--interval", default="4h")
    ap.add_argument("--symbols", default="BTCUSDT")
    ap.add_argument("--strategies", default="FNG_EMA_MR")
    ap.add_argument("--output", default="output/verification_bundle.json")
    args = ap.parse_args()

    now_ms = int(time.time() * 1000)
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    keys = [s.strip() for s in args.strategies.split(",") if s.strip()]
    for key in keys:
        if key not in STRATEGY_ID_MAP:
            print(f"UNKNOWN_STRATEGY: {key}", file=sys.stderr)
            return 2

    print(f"[bundle] fetching REAL Fear & Greed data ...", flush=True)
    fng_pts = fetch_fng(limit=1000) or []
    print(f"[bundle] fng points={len(fng_pts)}", flush=True)

    runs = []
    for key in keys:
        for symbol in symbols:
            print(f"[bundle] {key} / {symbol}: real Binance klines + simulate + WF + grid ...", flush=True)
            runs.append(build_run(key, symbol, args, fng_pts, now_ms))
            r = runs[-1]
            print(f"[bundle]   bars={r.get('bars')} sample={r['metrics']['sample_count']} "
                  f"oos={r['metrics']['oos_trades']} pass={r['gates']['strategy_pass']}/"
                  f"{r['gates']['oos_pass']} reasons={r['gates']['reasons']}", flush=True)

    is_gha = os.environ.get("GITHUB_ACTIONS") == "true"
    provenance = {
        "repository": os.environ.get("GITHUB_REPOSITORY") or "yihui315/night-researcher-dash",
        "git_commit_sha": os.environ.get("GITHUB_SHA") or git_head(),
        "git_ref": os.environ.get("GITHUB_REF") or "local",
        "workflow_run_id": os.environ.get("GITHUB_RUN_ID") or "",
        "workflow_name": os.environ.get("GITHUB_WORKFLOW") or "strategy-verification",
        "workflow_ref": os.environ.get("GITHUB_WORKFLOW_REF") or "",
        "runner": "github-actions" if is_gha else "local",
        "engine_sha256": sha256_file(ROOT / "backtest_engine.py"),
        "strategy_source_sha256": sha256_file(ROOT / "strategies.py"),
        "research_source_sha256": sha256_file(ROOT / "run_research.py"),
        "runner_source_sha256": sha256_file(pathlib.Path(__file__).resolve()),
        "engine_mode": "real-python-backtest-engine",
        "generated_at": iso(now_ms),
        "thresholds": {"minSampleCount": MIN_SAMPLE_COUNT, "minOosTrades": MIN_OOS_TRADES, "folds": args.folds},
    }
    # The canonical string travels WITH the bundle. The server hashes exactly
    # these bytes and parses them as the authoritative payload, so Python/JS
    # float formatting differences can never create a false hash mismatch (or
    # worse, a false pass). The HMAC signature additionally binds the raw body.
    core = {"schema": SCHEMA, "provenance": provenance, "runs": runs}
    canonical_str = canonical(core).decode("utf-8")
    bundle = {
        **core,
        "canonical_payload": canonical_str,
        "bundle_sha256": sha256_bytes(canonical_str.encode("utf-8")),
    }

    out = ROOT / args.output
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[bundle] WROTE {out}", flush=True)
    print(f"[bundle] sha256={bundle['bundle_sha256']}", flush=True)
    print(f"[bundle] runner={provenance['runner']} (local bundles get trusted=0)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
