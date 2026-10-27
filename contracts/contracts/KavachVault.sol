// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TickMath} from "./libraries/TickMath.sol";

interface IUniswapV3PoolLite {
    // feeProtocol is declared uint32 so the decoder also accepts forks that widened it.
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint32, bool);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title KavachVault - an AI trading agent's vault with an on-chain parachute
/// @notice The owner deposits a stablecoin. An AI agent may open spot positions on HSKSwap (Uniswap V3)
/// pools, but only inside an on-chain policy. Every position is born with a stop-loss and a take-profit
/// that live in this contract, so they keep working when the AI crashes, hangs or is wrong:
///   * anyone can call keeperClose() once the pool's TWAP crosses a stop / take-profit and earns a reward
///   * if the agent stops sending heartbeats, anyone can unwind all positions (dead-man switch)
///   * every price check uses the pool's TWAP, and every swap is floored against the TWAP, so a
///     flash-loan or sandwich cannot trigger a stop or fill it at a manipulated price.
/// @dev 1 tick = 0.01% price move (1.0001^tick). Stop / take-profit distances are expressed in ticks.
contract KavachVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    struct Market {
        address pool;
        uint24 fee;
        bool baseIsToken0;
        bool enabled;
    }

    struct Policy {
        uint16 maxPositionBps; // max size of one position, % of equity (bps)
        uint16 maxExposureBps; // max value of all open positions, % of equity (bps)
        uint16 maxDailyLossBps; // opens are blocked once equity is down this much today
        uint16 maxSlippageBps; // agent swaps are floored at TWAP value minus this
        uint16 maxStopSlippageBps; // keeper closes (stops in fast markets) are floored at TWAP minus this
        uint16 minStopTicks; // a stop-loss is mandatory and at least this far ...
        uint16 maxStopTicks; // ... and at most this far below the entry
        uint16 maxTakeProfitTicks; // take-profit at most this far above the entry
        uint16 maxTwapDeviationTicks; // agent cannot trade while spot deviates this much from TWAP
        uint16 keeperRewardBps; // reward for whoever executes a stop / TP / dead-man close
        uint32 twapWindow; // seconds
        uint32 cooldown; // seconds between two opens
        uint32 heartbeatTimeout; // dead-man switch
    }

    struct Position {
        address base;
        uint128 baseAmount;
        uint128 quoteIn;
        int32 entryPriceTick; // TWAP price tick at open, in "base priced in quote" orientation
        int32 stopPriceTick;
        int32 takeProfitPriceTick;
        uint64 openedAt;
        bool open;
    }

    enum CloseReason {
        AGENT,
        OWNER,
        STOP_LOSS,
        TAKE_PROFIT,
        DEAD_MAN
    }

    // ------------------------------------------------------------------ storage

    uint256 public constant MAX_OPEN_POSITIONS = 8;
    uint16 public constant MAX_KEEPER_REWARD_BPS = 100;

    IERC20 public immutable quote;
    ISwapRouter02 public immutable router;

    address public owner;
    address public agent;
    bool public paused;

    Policy public policy;
    mapping(address base => Market) public markets;
    address[] public marketList;

    Position[] public positions;
    uint256[] internal _openIds;

    uint64 public lastHeartbeat;
    uint64 public lastOpenAt;
    uint64 public dayStart;
    uint256 public dayStartEquity;
    int256 public realizedPnl;
    uint256 public decisionCount;

    // ------------------------------------------------------------------ events

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event AgentChanged(address indexed agent);
    event OwnerChanged(address indexed owner);
    event PolicyChanged(Policy policy);
    event MarketSet(address indexed base, address pool, uint24 fee, bool baseIsToken0, bool enabled);
    event PausedSet(bool paused);
    event Heartbeat(address indexed agent, uint256 at);
    event Decision(uint256 indexed seq, address indexed base, string action, string reason);
    event PositionOpened(
        uint256 indexed id,
        address indexed base,
        uint256 quoteIn,
        uint256 baseOut,
        int32 entryPriceTick,
        int32 stopPriceTick,
        int32 takeProfitPriceTick,
        string reason
    );
    event StopAdjusted(uint256 indexed id, int32 stopPriceTick, int32 takeProfitPriceTick);
    event PositionClosed(
        uint256 indexed id, CloseReason indexed why, uint256 quoteOut, int256 pnl, address closer, uint256 keeperReward
    );

    // ------------------------------------------------------------------ errors

    error NotOwner();
    error NotAgent();
    error NotAgentOrOwner();
    error VaultPaused();
    error MarketDisabled(address base);
    error Cooldown(uint256 readyAt);
    error TooManyPositions();
    error PositionTooLarge(uint256 quoteIn, uint256 maxQuoteIn);
    error ExposureTooHigh(uint256 exposureAfter, uint256 maxExposure);
    error DailyLossLimit(uint256 lossBps, uint256 maxLossBps);
    error StopOutOfRange(uint16 stopTicks, uint16 minTicks, uint16 maxTicks);
    error TakeProfitOutOfRange(uint16 tpTicks, uint16 maxTicks);
    error TwapDeviation(int24 spotTick, int24 twapTick, uint16 maxDeviation);
    error NotTriggered(int32 priceTick, int32 stopPriceTick, int32 takeProfitPriceTick);
    error PositionNotOpen(uint256 id);
    error StopCanOnlyTighten(int32 current, int32 requested);
    error StopAboveMarket(int32 requested, int32 priceTick);
    error InvalidPolicy();
    error ZeroAmount();
    error ZeroAddress();

    // ------------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier onlyAgentOrOwner() {
        if (msg.sender != agent && msg.sender != owner) revert NotAgentOrOwner();
        _;
    }

    constructor(IERC20 quote_, ISwapRouter02 router_, address agent_, Policy memory policy_) {
        if (address(quote_) == address(0) || address(router_) == address(0) || agent_ == address(0)) {
            revert ZeroAddress();
        }
        quote = quote_;
        router = router_;
        owner = msg.sender;
        agent = agent_;
        _setPolicy(policy_);
        lastHeartbeat = uint64(block.timestamp);
        dayStart = uint64(block.timestamp - (block.timestamp % 1 days));
        emit OwnerChanged(msg.sender);
        emit AgentChanged(agent_);
    }

    // ================================================================== owner

    function deposit(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        quote.safeTransferFrom(msg.sender, address(this), amount);
        dayStartEquity += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice The owner can always take any token out, positions open or not.
    function withdraw(IERC20 token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        if (address(token) == address(quote)) {
            dayStartEquity = dayStartEquity > amount ? dayStartEquity - amount : 0;
        }
        emit Withdrawn(address(token), to, amount);
    }

    function setAgent(address agent_) external onlyOwner {
        if (agent_ == address(0)) revert ZeroAddress();
        agent = agent_;
        emit AgentChanged(agent_);
    }

    function transferOwnership(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    function setPolicy(Policy calldata policy_) external onlyOwner {
        _setPolicy(policy_);
    }

    function setMarket(address base, address pool, bool enabled) external onlyOwner {
        if (base == address(0) || pool == address(0)) revert ZeroAddress();
        IUniswapV3PoolLite p = IUniswapV3PoolLite(pool);
        address t0 = p.token0();
        address t1 = p.token1();
        bool baseIsToken0 = t0 == base;
        if (!((baseIsToken0 && t1 == address(quote)) || (t1 == base && t0 == address(quote)))) revert InvalidPolicy();
        if (markets[base].pool == address(0)) marketList.push(base);
        markets[base] = Market({pool: pool, fee: p.fee(), baseIsToken0: baseIsToken0, enabled: enabled});
        IERC20(base).forceApprove(address(router), type(uint256).max);
        quote.forceApprove(address(router), type(uint256).max);
        emit MarketSet(base, pool, markets[base].fee, baseIsToken0, enabled);
    }

    /// @notice Kill switch. Pausing blocks new positions; stops, take-profits and closes keep working.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        if (!paused_) lastHeartbeat = uint64(block.timestamp);
        emit PausedSet(paused_);
    }

    /// @notice Last resort if a pool's oracle is unusable: drop the position from the book.
    /// The base tokens stay in the vault and can be withdrawn by the owner.
    function abandonPosition(uint256 id) external onlyOwner {
        Position storage pos = _openPosition(id);
        pos.open = false;
        _removeOpenId(id);
        emit PositionClosed(id, CloseReason.OWNER, 0, -int256(uint256(pos.quoteIn)), msg.sender, 0);
    }

    // ================================================================== agent

    function heartbeat() external onlyAgent {
        lastHeartbeat = uint64(block.timestamp);
        emit Heartbeat(msg.sender, block.timestamp);
    }

    /// @notice Record a decision (including "hold") with its reasoning on-chain. Also counts as heartbeat.
    function logDecision(address base, string calldata action, string calldata reason) external onlyAgent {
        lastHeartbeat = uint64(block.timestamp);
        emit Decision(++decisionCount, base, action, reason);
    }

    /// @notice Buy `base` with `quoteIn` of the stablecoin. The position is born with a stop and a take-profit.
    /// @param stopTicks distance of the stop-loss below the entry (1 tick = 0.01%)
    /// @param takeProfitTicks distance of the take-profit above the entry
    function openPosition(
        address base,
        uint256 quoteIn,
        uint16 stopTicks,
        uint16 takeProfitTicks,
        string calldata reason
    ) external onlyAgent nonReentrant returns (uint256 id) {
        if (paused) revert VaultPaused();
        if (quoteIn == 0) revert ZeroAmount();
        Market memory m = markets[base];
        if (!m.enabled) revert MarketDisabled(base);
        Policy memory pol = policy;
        if (block.timestamp < uint256(lastOpenAt) + pol.cooldown) revert Cooldown(uint256(lastOpenAt) + pol.cooldown);
        if (_openIds.length >= MAX_OPEN_POSITIONS) revert TooManyPositions();
        if (stopTicks < pol.minStopTicks || stopTicks > pol.maxStopTicks) {
            revert StopOutOfRange(stopTicks, pol.minStopTicks, pol.maxStopTicks);
        }
        if (takeProfitTicks == 0 || takeProfitTicks > pol.maxTakeProfitTicks) {
            revert TakeProfitOutOfRange(takeProfitTicks, pol.maxTakeProfitTicks);
        }

        int24 twapTick = _guardedTwapTick(m, pol);

        // ---- risk checks, all valued at TWAP
        (uint256 eq, uint256 exposure) = _equityAndExposure();
        _rollDay(eq);
        _checkDailyLoss(eq, pol);
        uint256 maxQuoteIn = (eq * pol.maxPositionBps) / 10_000;
        if (quoteIn > maxQuoteIn) revert PositionTooLarge(quoteIn, maxQuoteIn);
        uint256 maxExposure = (eq * pol.maxExposureBps) / 10_000;
        if (exposure + quoteIn > maxExposure) revert ExposureTooHigh(exposure + quoteIn, maxExposure);

        // ---- swap, floored against the TWAP
        uint256 expectedBase = _quoteToBase(m, quoteIn, twapTick);
        uint256 minOut = (expectedBase * (1_000_000 - m.fee) / 1_000_000) * (10_000 - pol.maxSlippageBps) / 10_000;
        uint256 baseOut = _swap(address(quote), base, m.fee, quoteIn, minOut);

        int32 entry = _priceTick(m, twapTick);
        id = positions.length;
        positions.push(
            Position({
                base: base,
                baseAmount: uint128(baseOut),
                quoteIn: uint128(quoteIn),
                entryPriceTick: entry,
                stopPriceTick: entry - int32(uint32(stopTicks)),
                takeProfitPriceTick: entry + int32(uint32(takeProfitTicks)),
                openedAt: uint64(block.timestamp),
                open: true
            })
        );
        _openIds.push(id);
        lastOpenAt = uint64(block.timestamp);
        lastHeartbeat = uint64(block.timestamp);

        emit PositionOpened(
            id, base, quoteIn, baseOut, entry, entry - int32(uint32(stopTicks)), entry + int32(uint32(takeProfitTicks)), reason
        );
        emit Decision(++decisionCount, base, "OPEN", reason);
    }

    /// @notice Close at market (TWAP-floored). The agent uses this to take profit early or cut a loser.
    function closePosition(uint256 id, string calldata reason) external onlyAgentOrOwner nonReentrant {
        Position storage pos = _openPosition(id);
        Market memory m = markets[pos.base];
        int24 twapTick = _twapTick(m.pool, policy.twapWindow);
        if (msg.sender == agent) {
            _checkDeviation(m, twapTick, policy.maxTwapDeviationTicks);
            lastHeartbeat = uint64(block.timestamp);
            emit Decision(++decisionCount, pos.base, "CLOSE", reason);
        }
        _close(id, pos, m, twapTick, msg.sender == owner ? CloseReason.OWNER : CloseReason.AGENT, 0, policy.maxSlippageBps);
    }

    /// @notice Move the stop-loss (e.g. a trailing stop). The agent can only tighten it, never loosen it.
    /// The owner can set any stop / take-profit.
    function adjustStop(uint256 id, int32 newStopPriceTick, int32 newTakeProfitPriceTick) external onlyAgentOrOwner {
        Position storage pos = _openPosition(id);
        if (msg.sender == agent) {
            if (newStopPriceTick < pos.stopPriceTick) revert StopCanOnlyTighten(pos.stopPriceTick, newStopPriceTick);
            Market memory m = markets[pos.base];
            int32 priceTick = _priceTick(m, _twapTick(m.pool, policy.twapWindow));
            if (newStopPriceTick >= priceTick) revert StopAboveMarket(newStopPriceTick, priceTick);
            if (newTakeProfitPriceTick > pos.entryPriceTick + int32(uint32(policy.maxTakeProfitTicks))) {
                revert TakeProfitOutOfRange(0, policy.maxTakeProfitTicks);
            }
            lastHeartbeat = uint64(block.timestamp);
        }
        pos.stopPriceTick = newStopPriceTick;
        pos.takeProfitPriceTick = newTakeProfitPriceTick;
        emit StopAdjusted(id, newStopPriceTick, newTakeProfitPriceTick);
    }

    // ================================================================== keepers (anyone)

    /// @notice Anyone can execute a triggered stop-loss / take-profit, or unwind after the dead-man timeout,
    /// and earns keeperRewardBps of the proceeds. Triggers use the TWAP; the fill is floored at the TWAP
    /// minus maxStopSlippageBps - wide enough to fill in a genuine fast market, too tight to be worth a sandwich.
    function keeperClose(uint256 id) external nonReentrant {
        Position storage pos = _openPosition(id);
        Market memory m = markets[pos.base];
        int24 twapTick = _twapTick(m.pool, policy.twapWindow);
        int32 priceTick = _priceTick(m, twapTick);

        CloseReason why;
        if (isDeadManTriggered()) {
            why = CloseReason.DEAD_MAN;
            if (!paused) {
                paused = true;
                emit PausedSet(true);
            }
        } else if (priceTick <= pos.stopPriceTick) {
            why = CloseReason.STOP_LOSS;
        } else if (priceTick >= pos.takeProfitPriceTick) {
            why = CloseReason.TAKE_PROFIT;
        } else {
            revert NotTriggered(priceTick, pos.stopPriceTick, pos.takeProfitPriceTick);
        }
        _close(id, pos, m, twapTick, why, policy.keeperRewardBps, policy.maxStopSlippageBps);
    }

    // ================================================================== views

    function isDeadManTriggered() public view returns (bool) {
        return block.timestamp > uint256(lastHeartbeat) + policy.heartbeatTimeout;
    }

    function openPositionIds() external view returns (uint256[] memory) {
        return _openIds;
    }

    function positionsCount() external view returns (uint256) {
        return positions.length;
    }

    function getMarkets() external view returns (address[] memory) {
        return marketList;
    }

    /// @notice Equity = stablecoin balance + open positions valued at TWAP.
    function equity() external view returns (uint256 total, uint256 exposure) {
        return _equityAndExposure();
    }

    /// @notice Why is (or isn't) a position closable by a keeper right now? 0 = no, else CloseReason + 1.
    function keeperStatus(uint256 id) external view returns (uint8 status, int32 priceTick) {
        Position memory pos = positions[id];
        if (!pos.open) return (0, 0);
        Market memory m = markets[pos.base];
        priceTick = _priceTick(m, _twapTick(m.pool, policy.twapWindow));
        if (isDeadManTriggered()) return (uint8(CloseReason.DEAD_MAN) + 1, priceTick);
        if (priceTick <= pos.stopPriceTick) return (uint8(CloseReason.STOP_LOSS) + 1, priceTick);
        if (priceTick >= pos.takeProfitPriceTick) return (uint8(CloseReason.TAKE_PROFIT) + 1, priceTick);
        return (0, priceTick);
    }

    function currentTwapTick(address base) external view returns (int24) {
        return _twapTick(markets[base].pool, policy.twapWindow);
    }

    // ================================================================== internal

    function _setPolicy(Policy memory p) internal {
        if (
            p.maxPositionBps == 0 || p.maxPositionBps > 10_000 || p.maxExposureBps > 10_000 || p.maxDailyLossBps == 0
                || p.maxDailyLossBps > 10_000 || p.maxSlippageBps > 2_000 || p.maxStopSlippageBps < p.maxSlippageBps
                || p.maxStopSlippageBps > 1_000 || p.minStopTicks == 0
                || p.minStopTicks > p.maxStopTicks || p.maxTakeProfitTicks == 0 || p.keeperRewardBps > MAX_KEEPER_REWARD_BPS
                || p.twapWindow < 60 || p.heartbeatTimeout < 5 minutes
        ) revert InvalidPolicy();
        policy = p;
        emit PolicyChanged(p);
    }

    function _close(
        uint256 id,
        Position storage pos,
        Market memory m,
        int24 twapTick_,
        CloseReason why,
        uint16 rewardBps,
        uint16 slippageBps
    ) internal {
        uint256 expectedQuote = _baseToQuote(m, pos.baseAmount, twapTick_);
        uint256 minOut = (expectedQuote * (1_000_000 - m.fee) / 1_000_000) * (10_000 - slippageBps) / 10_000;
        uint256 quoteOut = _swap(pos.base, address(quote), m.fee, pos.baseAmount, minOut);

        uint256 reward = (quoteOut * rewardBps) / 10_000;
        if (reward > 0) quote.safeTransfer(msg.sender, reward);

        int256 pnl = int256(quoteOut - reward) - int256(uint256(pos.quoteIn));
        realizedPnl += pnl;
        pos.open = false;
        _removeOpenId(id);
        emit PositionClosed(id, why, quoteOut - reward, pnl, msg.sender, reward);
    }

    function _swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256)
    {
        return router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _openPosition(uint256 id) internal view returns (Position storage pos) {
        if (id >= positions.length || !positions[id].open) revert PositionNotOpen(id);
        pos = positions[id];
    }

    function _removeOpenId(uint256 id) internal {
        uint256 n = _openIds.length;
        for (uint256 i; i < n; ++i) {
            if (_openIds[i] == id) {
                _openIds[i] = _openIds[n - 1];
                _openIds.pop();
                return;
            }
        }
    }

    function _equityAndExposure() internal view returns (uint256 total, uint256 exposure) {
        uint256 n = _openIds.length;
        for (uint256 i; i < n; ++i) {
            Position memory pos = positions[_openIds[i]];
            Market memory m = markets[pos.base];
            exposure += _baseToQuote(m, pos.baseAmount, _twapTick(m.pool, policy.twapWindow));
        }
        total = quote.balanceOf(address(this)) + exposure;
    }

    function _rollDay(uint256 equityNow) internal {
        if (block.timestamp >= uint256(dayStart) + 1 days) {
            dayStart = uint64(block.timestamp - (block.timestamp % 1 days));
            dayStartEquity = equityNow;
        }
    }

    function _checkDailyLoss(uint256 equityNow, Policy memory pol) internal view {
        if (dayStartEquity > 0 && equityNow < dayStartEquity) {
            uint256 lossBps = ((dayStartEquity - equityNow) * 10_000) / dayStartEquity;
            if (lossBps >= pol.maxDailyLossBps) revert DailyLossLimit(lossBps, pol.maxDailyLossBps);
        }
    }

    function _guardedTwapTick(Market memory m, Policy memory pol) internal view returns (int24 t) {
        t = _twapTick(m.pool, pol.twapWindow);
        _checkDeviation(m, t, pol.maxTwapDeviationTicks);
    }

    function _checkDeviation(Market memory m, int24 twapTick_, uint16 maxDev) internal view {
        (, int24 spotTick,,,,,) = IUniswapV3PoolLite(m.pool).slot0();
        int256 d = int256(spotTick) - int256(twapTick_);
        if (d < 0) d = -d;
        if (uint256(d) > maxDev) revert TwapDeviation(spotTick, twapTick_, maxDev);
    }

    /// @dev Arithmetic mean tick over `window` seconds, rounded towards negative infinity (as OracleLibrary).
    function _twapTick(address pool, uint32 window) internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory cum,) = IUniswapV3PoolLite(pool).observe(ago);
        int56 delta = cum[1] - cum[0];
        int56 w = int56(uint56(window));
        int24 t = int24(delta / w);
        if (delta < 0 && (delta % w != 0)) t--;
        return t;
    }

    /// @dev Pool tick re-oriented so that a higher value always means "base is worth more quote".
    function _priceTick(Market memory m, int24 tick) internal pure returns (int32) {
        return m.baseIsToken0 ? int32(tick) : -int32(tick);
    }

    function _baseToQuote(Market memory m, uint256 baseAmount, int24 tick) internal pure returns (uint256) {
        uint256 sqrtP = TickMath.getSqrtRatioAtTick(tick);
        if (m.baseIsToken0) {
            // price(token1 per token0) = sqrtP^2 / 2^192
            return Math.mulDiv(Math.mulDiv(baseAmount, sqrtP, 1 << 96), sqrtP, 1 << 96);
        }
        return Math.mulDiv(Math.mulDiv(baseAmount, 1 << 96, sqrtP), 1 << 96, sqrtP);
    }

    function _quoteToBase(Market memory m, uint256 quoteAmount, int24 tick) internal pure returns (uint256) {
        uint256 sqrtP = TickMath.getSqrtRatioAtTick(tick);
        if (m.baseIsToken0) {
            return Math.mulDiv(Math.mulDiv(quoteAmount, 1 << 96, sqrtP), 1 << 96, sqrtP);
        }
        return Math.mulDiv(Math.mulDiv(quoteAmount, sqrtP, 1 << 96), sqrtP, 1 << 96);
    }
}
