# KAVACH – deine Schritt-für-Schritt-Anleitung

**Abgabeschluss: Sonntag, 1. November 2026, 17:00 Uhr deutscher Zeit** (21:30 IST). Danach schließt DoraHacks automatisch.

## 1. Lokal ausprobieren (10 Minuten)

Du brauchst Node.js 20 oder neuer (auf deinem Mac: `node -v`).

```bash
cd kavach
cp .env.example .env
cd agent
npm install
npm run sim
```

Dann im Browser **http://localhost:8787** öffnen. Klick auf **„Crash test“** – du siehst, wie die KI „stirbt“, der Markt fällt und ein öffentlicher Keeper den Stop-Loss ausführt.

Danach `npm run probe` – das liest die echten HSKSwap-Pools auf dem Mainnet (ohne Wallet). Wenn dort Preise und Spreads erscheinen, funktioniert die Live-Verbindung.

## 2. Zwei Wallets anlegen

- **Owner-Wallet** (z. B. in MetaMask ein neues Konto): deployt den Vault, nur sie kann Geld abheben.
- **Agent-Wallet**: ein *separates, frisches* Konto nur für den Bot.

Private Keys in `.env` eintragen: `DEPLOYER_PRIVATE_KEY`, `AGENT_ADDRESS`, `AGENT_PRIVATE_KEY`.
⚠️ Die `.env` niemals hochladen oder teilen (sie steht schon in `.gitignore`).

## 3. Etwas HSK für Gas besorgen

Das Deployment kostet nur Bruchteile eines Cents. Du brauchst ein paar HSK auf der **HSK Chain (Chain-ID 177)** in der Owner-Wallet und etwas in der Agent-Wallet. Wege: HSK an einer Börse kaufen und, falls angeboten, über das Netzwerk „HashKey Chain“ auszahlen, oder über die offizielle HashKey-Chain-Bridge. Bei Problemen im Hackathon-Telegram fragen: https://t.me/+M5yaRB-u4PRiNWM1

## 4. Auf dem Mainnet deployen (Pflicht für Preisgeld!)

```bash
cd ../contracts
npm install
npx hardhat test
DRY_RUN=1 npx hardhat run scripts/deploy.js --network hsk
npx hardhat run scripts/deploy.js --network hsk
```

Das Skript prüft die Pools, deployt `KavachVault`, schaltet HSK/ETH/BTC frei und speichert alles in `contracts/deployments/hsk-mainnet.json`. **Kopiere die Explorer-Links aus der Ausgabe** – die kommen in die Abgabe.

Optional, für echte Trades in der Demo (echtes Geld, klein anfangen): USDT auf HSK Chain in die Owner-Wallet, dann
`AMOUNT=10 npx hardhat run scripts/deposit.js --network hsk` und `cd ../agent && npm run live`.
Ohne Einzahlung reicht `npm run paper` (echte Kurse, simulierte Trades) für die Demo.

## 5. Auf GitHub hochladen

Neues öffentliches Repo `kavach` unter **ElTanque81** anlegen und den Ordner hochladen (ohne `.env`, ohne `node_modules`).

## 6. Demo-Video aufnehmen (2–3 Minuten)

Skript steht in `SUBMISSION.md`. Bildschirm aufnehmen (QuickTime auf dem Mac reicht), Dashboard im SIM- oder PAPER-Modus, Crash-Test zeigen, Explorer-Link vom Vault zeigen. Auf YouTube (nicht gelistet) hochladen.

## 7. Auf DoraHacks einreichen

1. https://dorahacks.io/hackathon/hskchainindia → **Register** (als ElTanque81).
2. **Submit Build** → Track **AI Agent Trading** wählen.
3. Texte aus `SUBMISSION.md` einfügen, GitHub-Link, Video-Link, Vault-Adresse + Explorer-Link.
4. Optional: Online-Demo am 4. November – Teams aus Mumbai werden bevorzugt, aber Online-Teilnahme ist möglich. Den zugeteilten Slot **pünktlich** wahrnehmen, sonst verfällt er.

## Checkliste

- [ ] `npm run sim` läuft, Crash-Test funktioniert
- [ ] `npm run probe` zeigt echte Kurse
- [ ] Vault auf HSK Chain Mainnet deployt (Adresse + Tx-Link notiert)
- [ ] GitHub-Repo öffentlich
- [ ] Video hochgeladen
- [ ] BUIDL bis **1.11., 17:00 Uhr** eingereicht
