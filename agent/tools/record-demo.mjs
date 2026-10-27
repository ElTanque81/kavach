// Records a simulated session into public/demo-frames.js for the static replay demo (docs / DoraHacks link).
//   node tools/record-demo.mjs
process.env.MODE = "sim";
import fs from "node:fs";
const { Engine } = await import("../src/engine.js");
const { handleChat } = await import("../src/chat.js");

const e = new Engine("sim");
await e.init();
const frames = [];
const chats = [];
const snap = () => {
  const s = e.publicState();
  delete s.equityCurve;
  s.feed = s.feed.slice(-40);
  s.trades = s.trades.slice(0, 14);
  frames.push(s);
};
const say = async (text) => {
  const r = await handleChat(text, { settings: e.settings, policy: e.policy, state: e.state, snap: e.snap, engine: e });
  chats.push({ frame: frames.length, you: text, kavach: r.reply });
  if (r.changed?.length) e.log("You", `chat → ${r.changed.join(", ")}`);
};
e.running = true;
for (let i = 0; i < 330; i++) {
  await e.cycle();
  if (i === 60) await say("Wie läuft es?");
  if (i === 150) await say("Be a bit more careful, stop-loss 3%");
  if (i === 240) await say("How am I doing?");
  if (i % 3 === 0) snap();
}
await e.crashTest("WHSK");
snap();
for (let i = 0; i < 30; i++) {
  await e.cycle();
  if (i === 14) await say("Was ist gerade passiert?");
  snap();
}
const out = `window.KAVACH_DEMO = ${JSON.stringify({ frames, chats })};`;
fs.writeFileSync(new URL("../public/demo-frames.js", import.meta.url), out);
console.log("frames", frames.length, "bytes", out.length, "final equity", e.state.equity.toFixed(2));
