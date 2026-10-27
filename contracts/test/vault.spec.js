const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const USDT = (n) => ethers.parseUnits(String(n), 6);
const FEE = 3000;

const POLICY = {
  maxPositionBps: 2000,
  maxExposureBps: 6000,
  maxDailyLossBps: 500,
  maxSlippageBps: 100,
  maxStopSlippageBps: 300,
  minStopTicks: 100,
  maxStopTicks: 800,
  maxTakeProfitTicks: 2000,
  maxTwapDeviationTicks: 50,
  keeperRewardBps: 20,
  twapWindow: 600,
  cooldown: 60,
  heartbeatTimeout: 1800,
};

async function increaseTime(s) {
  await network.provider.send("evm_increaseTime", [s]);
  await network.provider.send("evm_mine");
}

/** pool tick for "1 base = price quote" given decimals and token order */
function tickFor(price, baseDec, quoteDec, baseIsToken0) {
  const raw = (price * 10 ** quoteDec) / 10 ** baseDec; // quote-wei per base-wei
  const t = Math.round(Math.log(raw) / Math.log(1.0001));
  return baseIsToken0 ? t : -t;
}

async function deploy() {
  const [owner, agent, keeper, stranger] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockERC20");
  const usdt = await Token.deploy("Tether USD", "USDT", 6);
  const whsk = await Token.deploy("Wrapped HSK", "WHSK", 18);
  const weth = await Token.deploy("Wrapped Ether", "WETH", 18);

  const Pool = await ethers.getContractFactory("MockV3Pool");
  const hskPool = await Pool.deploy(await whsk.getAddress(), await usdt.getAddress(), FEE);
  const ethPool = await Pool.deploy(await weth.getAddress(), await usdt.getAddress(), FEE);
  const hskBase0 = (await hskPool.token0()) === (await whsk.getAddress());
  const ethBase0 = (await ethPool.token0()) === (await weth.getAddress());

  const hskTick = tickFor(0.089, 18, 6, hskBase0);
  const ethTick = tickFor(2400, 18, 6, ethBase0);
  await hskPool.setBoth(hskTick);
  await ethPool.setBoth(ethTick);

  const Router = await ethers.getContractFactory("MockSwapRouter02");
  const router = await Router.deploy();
  await router.setPool(await whsk.getAddress(), await usdt.getAddress(), FEE, await hskPool.getAddress());
  await router.setPool(await weth.getAddress(), await usdt.getAddress(), FEE, await ethPool.getAddress());

  const Vault = await ethers.getContractFactory("KavachVault");
  const vault = await Vault.deploy(await usdt.getAddress(), await router.getAddress(), agent.address, POLICY);

  await vault.setMarket(await whsk.getAddress(), await hskPool.getAddress(), true);
  await vault.setMarket(await weth.getAddress(), await ethPool.getAddress(), true);

  await usdt.mint(owner.address, USDT(10_000));
  await usdt.approve(await vault.getAddress(), ethers.MaxUint256);
  await vault.deposit(USDT(10_000));

  // price ticks move in "base priced in quote" orientation; convert to pool ticks
  const hskPoolTick = (priceTickDelta) => hskTick + (hskBase0 ? priceTickDelta : -priceTickDelta);
  const ethPoolTick = (priceTickDelta) => ethTick + (ethBase0 ? priceTickDelta : -priceTickDelta);

  return { owner, agent, keeper, stranger, usdt, whsk, weth, hskPool, ethPool, router, vault, hskPoolTick, ethPoolTick, hskBase0, ethBase0 };
}

describe("KavachVault", function () {
  let c;
  beforeEach(async () => {
    c = await deploy();
  });

  it("values equity at the TWAP and lets the agent open a position inside the policy", async () => {
    const { vault, agent, whsk } = c;
    const [eq] = await vault.equity();
    expect(eq).to.equal(USDT(10_000));

    await expect(vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1500), 300, 600, "spread -0.8% vs CEX, momentum up"))
      .to.emit(vault, "PositionOpened");

    const pos = await vault.positions(0);
    expect(pos.open).to.equal(true);
    expect(pos.stopPriceTick).to.equal(pos.entryPriceTick - 300n);
    expect(pos.takeProfitPriceTick).to.equal(pos.entryPriceTick + 600n);
    // ~1500 USDT / 0.089 * (1 - 0.3% fee) ≈ 16,800 WHSK
    const hsk = Number(ethers.formatUnits(pos.baseAmount, 18));
    expect(hsk).to.be.closeTo(1500 / 0.089 * 0.997, 50);

    const [eq2, exposure] = await vault.equity();
    expect(Number(ethers.formatUnits(eq2, 6))).to.be.closeTo(10_000 - 1500 * 0.003, 2);
    expect(Number(ethers.formatUnits(exposure, 6))).to.be.closeTo(1500 * 0.997, 2);
  });

  it("works when the base token is token1 of the pool as well", async () => {
    const { vault, agent, weth, ethBase0 } = c;
    await vault.connect(agent).openPosition(await weth.getAddress(), USDT(1000), 200, 400, "eth breakout");
    const pos = await vault.positions(0);
    expect(Number(ethers.formatUnits(pos.baseAmount, 18))).to.be.closeTo((1000 / 2400) * 0.997, 0.001);
    const m = await vault.markets(await weth.getAddress());
    expect(m.baseIsToken0).to.equal(ethBase0);
  });

  it("rejects anyone but the agent", async () => {
    const { vault, stranger, whsk } = c;
    await expect(vault.connect(stranger).openPosition(await whsk.getAddress(), USDT(100), 300, 600, "x"))
      .to.be.revertedWithCustomError(vault, "NotAgent");
  });

  it("caps the size of one position", async () => {
    const { vault, agent, whsk } = c;
    await expect(vault.connect(agent).openPosition(await whsk.getAddress(), USDT(2500), 300, 600, "too big"))
      .to.be.revertedWithCustomError(vault, "PositionTooLarge");
  });

  it("caps total exposure across positions", async () => {
    const { vault, agent, whsk, weth } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(2000), 300, 600, "1");
    await increaseTime(61);
    await vault.connect(agent).openPosition(await weth.getAddress(), USDT(1990), 300, 600, "2");
    await increaseTime(61);
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1900), 300, 600, "3");
    await increaseTime(61);
    await expect(vault.connect(agent).openPosition(await weth.getAddress(), USDT(1000), 300, 600, "4"))
      .to.be.revertedWithCustomError(vault, "ExposureTooHigh");
  });

  it("forces a stop-loss inside the allowed range", async () => {
    const { vault, agent, whsk } = c;
    await expect(vault.connect(agent).openPosition(await whsk.getAddress(), USDT(100), 50, 600, "stop too tight"))
      .to.be.revertedWithCustomError(vault, "StopOutOfRange");
    await expect(vault.connect(agent).openPosition(await whsk.getAddress(), USDT(100), 2000, 600, "no real stop"))
      .to.be.revertedWithCustomError(vault, "StopOutOfRange");
    await expect(vault.connect(agent).openPosition(await whsk.getAddress(), USDT(100), 300, 0, "no tp"))
      .to.be.revertedWithCustomError(vault, "TakeProfitOutOfRange");
  });

  it("enforces the cooldown between opens", async () => {
    const { vault, agent, whsk } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(100), 300, 600, "1");
    await expect(vault.connect(agent).openPosition(await whsk.getAddress(), USDT(100), 300, 600, "2"))
      .to.be.revertedWithCustomError(vault, "Cooldown");
  });

  it("refuses to trade while the spot price is pushed away from the TWAP (flash manipulation guard)", async () => {
    const { vault, agent, whsk, hskPool, hskPoolTick } = c;
    await hskPool.setSpot(hskPoolTick(-300)); // someone dumped the pool in the same block
    await expect(vault.connect(agent).openPosition(await whsk.getAddress(), USDT(100), 300, 600, "buy the dip?"))
      .to.be.revertedWithCustomError(vault, "TwapDeviation");
  });

  it("lets ANY keeper execute a stop-loss once the TWAP crosses it, and pays a reward", async () => {
    const { vault, agent, keeper, usdt, whsk, hskPool, hskPoolTick } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1000), 300, 600, "long HSK");

    await expect(vault.connect(keeper).keeperClose(0)).to.be.revertedWithCustomError(vault, "NotTriggered");

    await hskPool.setBoth(hskPoolTick(-350)); // price fell ~3.4%
    const [status] = await vault.keeperStatus(0);
    expect(status).to.equal(3); // STOP_LOSS + 1

    await expect(vault.connect(keeper).keeperClose(0)).to.emit(vault, "PositionClosed");
    const pos = await vault.positions(0);
    expect(pos.open).to.equal(false);
    const reward = await usdt.balanceOf(keeper.address);
    expect(reward).to.be.gt(0n);
    expect(Number(ethers.formatUnits(await vault.realizedPnl(), 6))).to.be.lessThan(-30);
  });

  it("executes a take-profit the same way", async () => {
    const { vault, agent, keeper, whsk, hskPool, hskPoolTick } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1000), 300, 600, "long HSK");
    await hskPool.setBoth(hskPoolTick(650));
    await expect(vault.connect(keeper).keeperClose(0)).to.emit(vault, "PositionClosed").withArgs(0, 3, anyUint(), anyInt(), keeper.address, anyUint());
    expect(await vault.realizedPnl()).to.be.gt(0n);
  });

  it("does not trigger a stop from a spot-only spike (needs the TWAP)", async () => {
    const { vault, agent, keeper, whsk, hskPool, hskPoolTick } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1000), 300, 600, "long HSK");
    await hskPool.setSpot(hskPoolTick(-900)); // flash dump, TWAP unchanged
    await expect(vault.connect(keeper).keeperClose(0)).to.be.revertedWithCustomError(vault, "NotTriggered");
  });

  it("floors a stop fill at the TWAP, so a sandwich cannot fill it at a manipulated price", async () => {
    const { vault, agent, keeper, whsk, hskPool, hskPoolTick } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1000), 300, 600, "long HSK");
    await hskPool.setTwap(hskPoolTick(-350)); // genuine move: stop is triggered
    await hskPool.setSpot(hskPoolTick(-800)); // attacker front-runs the keeper and dumps the pool >3% below TWAP
    await expect(vault.connect(keeper).keeperClose(0)).to.be.revertedWith("Too little received");
    await hskPool.setSpot(hskPoolTick(-500)); // a genuine fast market (spot 1.5% under TWAP) still fills
    await expect(vault.connect(keeper).keeperClose(0)).to.emit(vault, "PositionClosed");
  });

  it("dead-man switch: if the agent goes silent, anyone can unwind and the vault pauses", async () => {
    const { vault, agent, keeper, whsk, weth } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1000), 300, 600, "a");
    await increaseTime(61);
    await vault.connect(agent).openPosition(await weth.getAddress(), USDT(1000), 300, 600, "b");

    await increaseTime(1000);
    await expect(vault.connect(keeper).keeperClose(0)).to.be.revertedWithCustomError(vault, "NotTriggered");
    await increaseTime(1000); // > 1800s without heartbeat
    expect(await vault.isDeadManTriggered()).to.equal(true);

    await expect(vault.connect(keeper).keeperClose(0)).to.emit(vault, "PositionClosed").withArgs(0, 4, anyUint(), anyInt(), keeper.address, anyUint());
    await vault.connect(keeper).keeperClose(1);
    expect(await vault.paused()).to.equal(true);
    expect((await vault.openPositionIds()).length).to.equal(0);
    await expect(vault.connect(agent).openPosition(await whsk.getAddress(), USDT(100), 300, 600, "c"))
      .to.be.revertedWithCustomError(vault, "VaultPaused");
  });

  it("heartbeats and logged decisions keep the dead-man switch from firing", async () => {
    const { vault, agent, keeper, whsk } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1000), 300, 600, "a");
    await increaseTime(1500);
    await expect(vault.connect(agent).logDecision(await whsk.getAddress(), "HOLD", "spread closed, waiting"))
      .to.emit(vault, "Decision");
    await increaseTime(1500);
    await expect(vault.connect(keeper).keeperClose(0)).to.be.revertedWithCustomError(vault, "NotTriggered");
  });

  it("the agent can trail a stop up, but never loosen it", async () => {
    const { vault, agent, whsk, hskPool, hskPoolTick } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1000), 300, 600, "a");
    const pos = await vault.positions(0);
    await expect(vault.connect(agent).adjustStop(0, pos.stopPriceTick - 10n, pos.takeProfitPriceTick))
      .to.be.revertedWithCustomError(vault, "StopCanOnlyTighten");
    await hskPool.setBoth(hskPoolTick(400));
    await vault.connect(agent).adjustStop(0, pos.entryPriceTick + 100n, pos.takeProfitPriceTick);
    expect((await vault.positions(0)).stopPriceTick).to.equal(pos.entryPriceTick + 100n);
    await expect(vault.connect(agent).adjustStop(0, pos.entryPriceTick + 500n, pos.takeProfitPriceTick))
      .to.be.revertedWithCustomError(vault, "StopAboveMarket");
  });

  it("blocks new positions after the daily loss limit", async () => {
    const { vault, agent, keeper, whsk, weth, hskPool, hskPoolTick } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(2000), 800, 600, "a");
    await increaseTime(61);
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1950), 800, 600, "b");
    await increaseTime(61);
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1900), 800, 600, "c");
    await hskPool.setBoth(hskPoolTick(-1000)); // -9.5% on ~5900 exposure ≈ -5.6% equity
    await vault.connect(keeper).keeperClose(0);
    await increaseTime(61);
    await expect(vault.connect(agent).openPosition(await weth.getAddress(), USDT(100), 300, 600, "revenge trade"))
      .to.be.revertedWithCustomError(vault, "DailyLossLimit");
  });

  it("only the owner withdraws; the owner can always exit and pause", async () => {
    const { vault, owner, agent, usdt, whsk } = c;
    await expect(vault.connect(agent).withdraw(await usdt.getAddress(), USDT(1), agent.address))
      .to.be.revertedWithCustomError(vault, "NotOwner");
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1000), 300, 600, "a");
    await vault.setPaused(true);
    await expect(vault.connect(agent).openPosition(await whsk.getAddress(), USDT(10), 300, 600, "b"))
      .to.be.revertedWithCustomError(vault, "VaultPaused");
    await vault.closePosition(0, "owner exit");
    const bal = await usdt.balanceOf(await vault.getAddress());
    await vault.withdraw(await usdt.getAddress(), bal, owner.address);
    expect(await usdt.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("owner can abandon a position if a pool oracle breaks", async () => {
    const { vault, agent, keeper, whsk, hskPool } = c;
    await vault.connect(agent).openPosition(await whsk.getAddress(), USDT(1000), 300, 600, "a");
    await hskPool.setOracleBroken(true);
    await expect(vault.connect(keeper).keeperClose(0)).to.be.revertedWith("OLD");
    await vault.abandonPosition(0);
    expect((await vault.openPositionIds()).length).to.equal(0);
  });

  it("rejects a policy that would remove the safety rails", async () => {
    const { vault } = c;
    await expect(vault.setPolicy({ ...POLICY, minStopTicks: 0 })).to.be.revertedWithCustomError(vault, "InvalidPolicy");
    await expect(vault.setPolicy({ ...POLICY, keeperRewardBps: 500 })).to.be.revertedWithCustomError(vault, "InvalidPolicy");
    await expect(vault.setPolicy({ ...POLICY, heartbeatTimeout: 10 })).to.be.revertedWithCustomError(vault, "InvalidPolicy");
    await expect(vault.setPolicy({ ...POLICY, maxStopSlippageBps: 50 })).to.be.revertedWithCustomError(vault, "InvalidPolicy");
  });
});

describe("TickMath", function () {
  it("matches the live HSKSwap WHSK/USDT pool on HSK Chain mainnet", async () => {
    // slot0 read from 0x4ff515761864e7838b0adb8b5b2b8b7a068905dc on 2026-10-27
    const sqrtP = 23613005119798848333503n;
    const tick = -300536;
    const H = await ethers.getContractFactory("TickMathHarness");
    const h = await H.deploy();
    const lo = await h.sqrtAt(tick);
    const hi = await h.sqrtAt(tick + 1);
    expect(lo <= sqrtP && sqrtP < hi).to.equal(true);
  });
});

// tiny matchers for withArgs
function anyUint() {
  return (v) => typeof v === "bigint" && v >= 0n;
}
function anyInt() {
  return (v) => typeof v === "bigint";
}
