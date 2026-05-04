import { useEffect, useState } from "react";

interface Stats {
  online: boolean;
  accounts: number;
  buyers: number;
  totalTokens: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function FlowAnimation() {
  return (
    <div className="flow">
      <div className="flow-track">
        <div className="flow-node">
          <div className="flow-node-label">Share</div>
          <div className="flow-node-sub">earn while idle</div>
        </div>

        <div className="flow-conn">
          <div className="flow-conn-line" />
          <div className="flow-dot flow-dot-fwd" style={{ animationDelay: "0s" }} />
          <div className="flow-dot flow-dot-fwd" style={{ animationDelay: "1.5s" }} />
          <div className="flow-dot flow-dot-rev" style={{ animationDelay: "0.8s" }} />
        </div>

        <div className="flow-node flow-node-hub">
          <div className="flow-node-label">x402</div>
          <div className="flow-node-sub">peer-to-peer</div>
        </div>

        <div className="flow-conn">
          <div className="flow-conn-line" />
          <div className="flow-dot flow-dot-fwd" style={{ animationDelay: "0.3s" }} />
          <div className="flow-dot flow-dot-fwd" style={{ animationDelay: "1.8s" }} />
          <div className="flow-dot flow-dot-rev" style={{ animationDelay: "1.1s" }} />
        </div>

        <div className="flow-node">
          <div className="flow-node-label">Rent</div>
          <div className="flow-node-sub">pay per token</div>
        </div>
      </div>

      <div className="flow-steps">
        <span className="flow-step" style={{ animationDelay: "0s" }}>
          Lend your idle Claude — earn USDG while you sleep
        </span>
        <span className="flow-step" style={{ animationDelay: "3s" }}>
          Rent Claude from peers when you need more capacity
        </span>
        <span className="flow-step" style={{ animationDelay: "6s" }}>
          x402 settles everything on-chain — no trust needed
        </span>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <span className="install-copy" onClick={copy} title="Click to copy">
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </span>
  );
}

function InstallCmd() {
  const cmd = "npx skills add jasonthewhale/weclaude";
  return (
    <div className="install" onClick={() => navigator.clipboard.writeText(cmd)} title="Click to copy">
      <code className="install-cmd">
        <span className="install-prompt">$</span> {cmd}
      </code>
      <CopyButton text={cmd} />
    </div>
  );
}

const MODELS = [
  { name: "Opus 4.7", input: 5, output: 25 },
  { name: "Opus 4.6", input: 5, output: 25 },
  { name: "Sonnet 4.6", input: 3, output: 15 },
  { name: "Haiku 4.5", input: 1, output: 5 },
];
const DISCOUNT = 0.1;
const CYCLE_DURATION = 3; // seconds per model

function App() {
  const [stats, setStats] = useState<Stats>({ online: false, accounts: 0, buyers: 0, totalTokens: 0 });

  useEffect(() => {
    const poll = () =>
      fetch("/health")
        .then((r) => r.json())
        .then((health) => {
          setStats({
            online: health?.status === "ok",
            accounts: health?.accounts ?? 0,
            buyers: health?.buyers ?? 0,
            totalTokens: health?.total_tokens ?? 0,
          });
        })
        .catch(() => setStats((s) => ({ ...s, online: false })));
    poll();
    const id = setInterval(poll, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="page">
      <nav className="nav">
        <div className="nav-brand">
          <span className="nav-prompt">&gt;</span> weclaude
        </div>
        <div className="nav-status">
          <span className={`dot ${stats.online ? "dot-ok" : "dot-off"}`} />
          {stats.online ? "x402 · live" : "connecting..."}
        </div>
      </nav>

      <main className="hero">
        <h1 className="title">
          We<span className="title-accent">Claude</span>
        </h1>
        <p className="subtitle">Your Claude for everyone. Everyone's Claude for you.</p>
        <div className="badge">
          Powered by{" "}
          <a
            href="https://web3.okx.com/onchainos"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src="/okx-logo.png" alt="OKX" className="badge-logo" />
            Onchain OS
          </a>
        </div>

        <FlowAnimation />

        <InstallCmd />

        {stats.online && (
          <div className="stats">
            <div className="stat">
              <span className="stat-value">{stats.accounts}</span>
              <span className="stat-label">Shared accounts</span>
            </div>
            <div className="stat">
              <span className="stat-value">{stats.buyers}</span>
              <span className="stat-label">Users</span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatTokens(stats.totalTokens)}</span>
              <span className="stat-label">Tokens consumed</span>
            </div>
            <div className="stat stat-pricing">
              <div className="pricing-carousel">
                {MODELS.map((m, i) => (
                  <div
                    key={m.name}
                    className="pricing-slide"
                    style={{ animationDelay: `${i * CYCLE_DURATION}s` }}
                  >
                    <span className="stat-value pricing-value">
                      <span className="pricing-official">${m.input}</span>
                      {" "}
                      <span className="pricing-ours">${(m.input * DISCOUNT).toFixed(2)}</span>
                      <span className="pricing-unit">/MTok</span>
                    </span>
                    <span className="stat-label pricing-model">{m.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <a href="#guide" className="cta-arrow">Get Started ↓</a>
      </main>

      <section className="guide" id="guide">
        <h2 className="guide-heading">Then tell Claude Code:</h2>
        <div className="guide-cards">
          <div className="guide-card">
            <span className="guide-label guide-label-lend">Earn while you sleep</span>
            <div className="guide-cmd-row">
              <code className="guide-cmd">/weclaude Share my Claude account</code>
              <CopyButton text="/weclaude Share my Claude account" />
            </div>
          </div>
          <div className="guide-card">
            <span className="guide-label guide-label-rent">
              Become a <span className="text-accent tip" data-tip="Claude Code = 10x. A well-used subscription = another 10x. That's 100x.">100x</span> Engineer
            </span>
            <div className="guide-cmd-row">
              <code className="guide-cmd">/weclaude Get me a $10 Claude API key</code>
              <CopyButton text="/weclaude Get me a $10 Claude API key" />
            </div>
          </div>
        </div>
      </section>

      <footer className="footer">
        <span>X Layer &middot; x402 Protocol &middot; USDG</span>
      </footer>
    </div>
  );
}

export default App;
