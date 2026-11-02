import { config } from "./config.js";
import { Engine } from "./engine.js";
import { startServer } from "./server.js";

const engine = new Engine(config.mode);
try {
  await engine.init();
} catch (e) {
  console.error(`\n[KAVACH] could not start in ${config.mode} mode: ${e.message}`);
  if (config.mode !== "sim") console.error("Tip: `npm run sim` runs fully offline with a simulated market.");
  process.exit(1);
}
startServer(engine, config.port);
// The agent waits for "Start agent" in the dashboard (or AUTO_START=true for unattended runs).
if (process.env.AUTO_START === "true") engine.start();
else console.log('  The agent is ready. Press "Start agent" in the dashboard to begin trading.\n');

process.on("SIGINT", () => {
  engine.stop();
  process.exit(0);
});
