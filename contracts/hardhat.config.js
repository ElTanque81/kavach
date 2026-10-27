require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the solc-js compiler from node_modules, so compiling works offline / behind strict proxies.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    return {
      compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: "0.8.24+commit.e11b9ed9",
    };
  }
  return runSuper();
});

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris" },
  },
  networks: {
    hsk: { url: process.env.HSK_RPC_URL || "https://mainnet.hsk.xyz", chainId: 177, accounts },
    hskTestnet: { url: "https://testnet.hsk.xyz", chainId: 133, accounts },
  },
  mocha: { timeout: 120000 },
};
