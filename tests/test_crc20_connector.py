import unittest
from unittest.mock import patch

from connectors_extra import _sat_per_leaf_to_usd, fetch_crc20_market_snapshot


class Crc20ConnectorTests(unittest.TestCase):
    def test_sat_per_leaf_usd_conversion_uses_decimal_arithmetic(self):
        self.assertEqual(_sat_per_leaf_to_usd("1.5", "100000"), "0.0015")
        self.assertIsNone(_sat_per_leaf_to_usd("unknown", "100000"))
        self.assertIsNone(_sat_per_leaf_to_usd("1.5", None))

    def test_crc20_market_snapshot_keeps_sale_and_pool_prices_separate(self):
        status = {"ok": True, "data": {"synced": True, "height": 100}}
        stats = {
            "ok": True,
            "data": {
                "token": {"tick": "LEAF", "decimals": 8, "supply": "100000000000000000", "holders": 1200, "height": 100},
                "market": {"last_unit_price_sat": "1.5", "last": {"txid": "a" * 64}, "sales": 20, "volume_sat": "100000"},
                "pool": {"swaps": 8, "last": {"leaf": "100000000000", "axbt": "1500", "side": "buy"}},
            },
        }
        history = {"ok": True, "data": {"items": [], "next_cursor": None}}
        with patch("connectors_extra.fetch_crc20_status", return_value=status), \
             patch("connectors_extra.fetch_crc20_stats", return_value=stats), \
             patch("connectors_extra.fetch_crc20_history", return_value=history):
            result = fetch_crc20_market_snapshot(btc_usdt="100000")

        self.assertTrue(result["ok"])
        self.assertTrue(result["trust"]["indexerSynced"])
        self.assertTrue(result["trust"]["statsHeightConsistent"])
        self.assertEqual(result["marketplace"]["lastSaleUnitPriceSat"], "1.5")
        self.assertEqual(result["marketplace"]["lastSaleUsdDerived"], "0.0015")
        self.assertEqual(result["pool"]["lastSwapUnitPriceSatDerived"], "1.5")
        self.assertIsNone(result["priceQuality"]["latestTradeUsd"])
        self.assertIsNone(result["priceQuality"]["recentVwap6hUsd"])
        self.assertIsNone(result["priceQuality"]["bestBidUsd"])
        self.assertIsNone(result["priceQuality"]["bestAskUsd"])

    def test_unsynced_indexer_is_not_trusted(self):
        status = {"ok": True, "data": {"synced": False, "height": 100}}
        stats = {"ok": True, "data": {"token": {"height": 100}, "market": {}, "pool": {}}}
        history = {"ok": True, "data": {"items": [], "next_cursor": None}}
        with patch("connectors_extra.fetch_crc20_status", return_value=status), \
             patch("connectors_extra.fetch_crc20_stats", return_value=stats), \
             patch("connectors_extra.fetch_crc20_history", return_value=history):
            result = fetch_crc20_market_snapshot()
        self.assertTrue(result["ok"])
        self.assertFalse(result["trust"]["indexerSynced"])


if __name__ == "__main__":
    unittest.main()
