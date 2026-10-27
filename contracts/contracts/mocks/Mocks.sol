// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "../libraries/TickMath.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Minimal Uniswap V3 pool surface: slot0, observe (TWAP) and tokens.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    uint160 public sqrtPriceX96;
    int24 public spotTick;
    int24 public twapTickValue;
    bool public oracleBroken;

    constructor(address a, address b, uint24 fee_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
    }

    function setSpot(int24 tick) public {
        spotTick = tick;
        sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick);
    }

    function setTwap(int24 tick) public {
        twapTickValue = tick;
    }

    function setBoth(int24 tick) external {
        setSpot(tick);
        setTwap(tick);
    }

    function setOracleBroken(bool b) external {
        oracleBroken = b;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, spotTick, 0, 16, 16, 0, true);
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory cum, uint160[] memory spl) {
        require(!oracleBroken, "OLD");
        cum = new int56[](secondsAgos.length);
        spl = new uint160[](secondsAgos.length);
        int56 t = 1_000_000_000;
        for (uint256 i; i < secondsAgos.length; ++i) {
            cum[i] = int56(twapTickValue) * (t - int56(uint56(secondsAgos[i])));
        }
    }
}

/// @notice Swaps at the pool's SPOT price minus fee (so a manipulated spot produces a manipulated fill),
/// with an optional extra haircut to simulate price impact.
contract MockSwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    mapping(bytes32 => address) public pools;
    uint256 public impactBps;

    function setPool(address a, address b, uint24 fee, address pool) external {
        pools[_key(a, b, fee)] = pool;
    }

    function setImpactBps(uint256 bps) external {
        impactBps = bps;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        MockV3Pool pool = MockV3Pool(pools[_key(p.tokenIn, p.tokenOut, p.fee)]);
        require(address(pool) != address(0), "no pool");
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        uint256 sqrtP = pool.sqrtPriceX96();
        uint256 inAfterFee = p.amountIn * (1_000_000 - p.fee) / 1_000_000;
        if (p.tokenIn == pool.token0()) {
            out = Math.mulDiv(Math.mulDiv(inAfterFee, sqrtP, 1 << 96), sqrtP, 1 << 96);
        } else {
            out = Math.mulDiv(Math.mulDiv(inAfterFee, 1 << 96, sqrtP), 1 << 96, sqrtP);
        }
        out = out * (10_000 - impactBps) / 10_000;
        require(out >= p.amountOutMinimum, "Too little received");
        MockERC20(p.tokenOut).mint(p.recipient, out);
    }

    function _key(address a, address b, uint24 fee) internal pure returns (bytes32) {
        (address x, address y) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(x, y, fee));
    }
}

contract TickMathHarness {
    function sqrtAt(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(tick);
    }
}

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped HSK", "WHSK") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
