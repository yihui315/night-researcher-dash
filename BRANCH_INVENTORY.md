# BRANCH_INVENTORY.md — 分支清单（真实核查，2026-11-02 GMT+8）

> 由 WorkBuddy 在 T00 阶段通过 `git` 真实核查生成。所有 tip/状态均为命令实际输出，非推测。
> 纪律：不直接修改 `main` / `master`；废弃分支只标记不删除。

---

## A. 仓库 `night_researcher`（路径 `D:\数据分析\night_researcher`）

Fetch URL: `https://github.com/yihui315/night-researcher-dash.git`

### 本地分支
| 分支 | tip | 状态 | 说明 |
|---|---|---|---|
| `main` | `b9eee3b` (2026-11-01) | ⚠️ 与 origin/main 不一致 | **不直改**。本地与 `origin/main`(`43c63e9`) 分叉，未调查、未改动 |
| `feat/p2-fixedpoint` | `6e780ab` (2026-11-02) | 🟢 当前工作分支 | 定点精度修复；领先分支 A 4 个提交，已全部推送 origin |
| `feat/p2-paper-backend` | `df8f643` (2026-11-02) | 🔴 废弃候选 | 本地独有、无 origin 远端；重复建设，不删不推进 |

### 远程分支（origin）
| 分支 | tip | 角色 |
|---|---|---|
| `origin/main` | `43c63e9` (2026-11-01) | 主稳定线（勿直推） |
| `origin/feat/p2-server-authoritative-paper` | `107a6ec` (2026-11-02) | **分支 A — P2 服务端权威引擎 canonical**（成熟：1035 行引擎 + 双迁移 + 14 API + JEV 对接 + 测试） |
| `origin/feat/p2-fixedpoint` | `6e780ab` (2026-11-02) | 本工作分支（PR 目标 head） |
| `origin/feat/paper-trading-command-center` | `360d1df` (2026-11-02) | P2 前端 + JEV 对接（trading.html/market3d + `integration/jev/tradingApi.mjs`） |
| `origin/diagnostics/e2e-41360202064` | `ddacdec` (2026-11-01) | 诊断/e2e 分支 |

### 关键关系
- `feat/p2-fixedpoint` → 基于 `feat/p2-server-authoritative-paper`（分支 A）。
  - `git rev-list --count origin/feat/p2-server-authoritative-paper..HEAD` = **4**（ecc37a2 / 6e60b9d / 26cefef / 6e780ab）。
- PR 目标：`base = feat/p2-server-authoritative-paper`，`head = feat/p2-fixedpoint`（**不碰 main**）。
- `feat/p2-paper-backend` 与分支 A 功能重叠，其定点层已并入 `feat/p2-fixedpoint`，判定退役。

### 三条件分支核查（指令 T00 §4）
- [x] `feat/p2-server-authoritative-paper` — 存在（origin）
- [x] `feat/p2-fixedpoint` — 存在（local + origin）
- [x] `feat/paper-trading-command-center` — 存在（origin）

---

## B. 仓库 `jev`（路径 `D:\jev`）

> 注：本阶段**仅只读核查**，未提交/未改动任何文件。当前分支 `release/jcc-v1.3-final` 有未提交改动（用户文件），按纪律不动。

### 本地分支
| 分支 | tip | 状态 |
|---|---|---|
| `master` | `a3dd89c` (2026-09-26) | 与 origin/master 同步 ✅ |
| `release/jcc-v1.3-final` | `cb35fba` (2026-11-02) | 🟢 当前分支；有未提交改动（用户文件，不碰） |
| `feature/jcc-v1.1-activation` | `7cd9a67` (2026-09-28) | 历史 |
| `feature/jcc-v1.2-visual-command-center` | `e836636` (2026-09-29) | 历史 |
| `archive/pre-freeze-reanchor` | — | 归档 |
| `release/v1.0.1-ops` | — | 运维 |

### 远程分支（origin）
| 分支 | tip | 说明 |
|---|---|---|
| `origin/master` | `a3dd89c` | 与本地 master 同步 |
| `origin/release/jcc-v1.3-final` | `cb35fba` | 与本地 release 同步 |

### master 与 release/jcc-v1.3-final 关系
- `git rev-list --left-right --count master...release/jcc-v1.3-final` = **`0 230`**
  - 左（master 独有）= 0 → master 的全部提交都包含在 release 中。
  - 右（release 独有）= 230 → release 领先 master 230 个提交，**尚未回并 master**。
- 结论：典型 release 分支模式（在 release 上收口 v1.3，master 暂为旧稳定线），**非异常**；后续如需正式发布，由主理人决定是否将 release 回并 master（须经 PR，不直推）。

### JEV 未提交文件（仅记录，不碰）
- 已修改：`artifacts/acceptance/CONTINUATION_INFRA_TEST.json`、`artifacts/release/v1.3_final/FORGE_INCIDENT_001.md`、`artifacts/release/v1.3_final/SIMULATION_ACCEPTANCE.json`
- 未跟踪：大量 `artifacts/release/v1.3_final/*`（备份目录、日志、commit_msg 等）——属用户/发布产物，不纳入本项目提交。

---

## C. 统一项目目录（T00 约定）
- 主开发目录：`D:\数据分析\night_researcher`（活跃）
- JEV 集成目录：`D:\jev\apps\command_center_3d`（待 Phase 2 启动）
- 统一文档（根）：`PROJECT_STATUS.md` / `TASK_BOARD.md` / `ARCHITECTURE.md` / `BRANCH_INVENTORY.md` / `DAILY_LOG.md`
- 报告目录（T02+）：`reports/`
