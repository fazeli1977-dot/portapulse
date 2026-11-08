import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Cpu,
  Flame,
  Layers,
  Radio,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import {
  DEFAULT_ENDPOINT_ID,
  ENDPOINTS,
  getEndpoint,
  PORTALDOT_TESTNET,
} from "./lib/endpoints.js";
import {
  deployProofContract,
  ensurePortaldotTestnet,
  getInjectedWallet,
  sendProofTransaction,
} from "./lib/evm-wallet.js";
import {
  PORTAPULSE_PROOF_BYTECODE,
  PORTAPULSE_PULSE_CALLDATA,
} from "./lib/portapulse-contract.js";

const FINALITY_POLL_MS = 15000;
const MAX_BLOCK_SAMPLES = 6;
const WEBHOOK_STORAGE_KEY = "portapulse.webhook";
const PROOF_STORAGE_KEY = "portapulse.evmProof";

function formatBlock(number) {
  return number === null || number === undefined ? "—" : `#${number.toLocaleString("en-US")}`;
}

function formatBlockTime(samples) {
  if (samples.length < 2) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const filtered = samples.filter((value) => value <= median * 3);
  if (filtered.length < 2) return null;
  const mean = filtered.reduce((total, value) => total + value, 0) / filtered.length;
  return mean;
}

function StatusPill({ status, chain }) {
  const map = {
    connecting: { text: "Connecting…", color: "text-amber-400", icon: Radio },
    connected: { text: chain ? `Live: ${chain}` : "Connected", color: "text-[#00E599]", icon: Radio },
    error: { text: "Connection failed", color: "text-rose-400", icon: AlertTriangle },
    idle: { text: "Disconnected", color: "text-slate-400", icon: Radio },
  };
  const entry = map[status] ?? map.idle;
  const Icon = entry.icon;
  return (
    <div className="flex items-center gap-2 bg-[#151A23] border border-slate-800 px-3 py-1.5 rounded-lg text-xs font-mono">
      <Icon className={`w-3.5 h-3.5 ${entry.color} ${status === "connecting" ? "animate-pulse" : ""}`} />
      <span className="max-w-[240px] truncate">{entry.text}</span>
    </div>
  );
}

function MetricCard({ label, icon, iconColor, value, valueColor, footnote, footnoteIcon }) {
  const FootnoteIcon = footnoteIcon;
  return (
    <div className="bg-[#151A23] border border-slate-800/80 hover:border-slate-700 p-5 rounded-2xl transition">
      <div className="flex items-center justify-between text-slate-400 text-xs mb-2">
        <span>{label}</span>
        <span className={iconColor}>{icon}</span>
      </div>
      <div className={`text-3xl font-extrabold font-mono tracking-wider ${valueColor ?? "text-white"}`}>
        {value}
      </div>
      <div className="text-[11px] text-slate-400 mt-2 flex items-center gap-1 font-mono">
        {FootnoteIcon ? <FootnoteIcon className="w-3 h-3" /> : null}
        {footnote}
      </div>
    </div>
  );
}

export default function App() {
  const [endpointId, setEndpointId] = useState(DEFAULT_ENDPOINT_ID);
  const [status, setStatus] = useState("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [chainInfo, setChainInfo] = useState(null);
  const [bestBlock, setBestBlock] = useState(null);
  const [finalizedBlock, setFinalizedBlock] = useState(null);
  const [blockSamples, setBlockSamples] = useState([]);
  const [headStats, setHeadStats] = useState(null);
  const [paused, setPaused] = useState(false);

  const [benchmarking, setBenchmarking] = useState(false);
  const [benchmarks, setBenchmarks] = useState({});

  const [stressCount, setStressCount] = useState(10);
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState(null);

  const [webhookUrl, setWebhookUrl] = useState(() => {
    try {
      return window.localStorage.getItem(WEBHOOK_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [webhookSaved, setWebhookSaved] = useState(false);
  const [walletAccount, setWalletAccount] = useState(null);
  const [walletVerified, setWalletVerified] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletMessage, setWalletMessage] = useState("");
  const [proof, setProof] = useState(() => {
    try {
      return JSON.parse(window.localStorage.getItem(PROOF_STORAGE_KEY) ?? "null");
    } catch {
      return null;
    }
  });

  const apiRef = useRef(null);
  const unsubRef = useRef(null);
  const lastHeadAtRef = useRef(null);
  const pausedRef = useRef(paused);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
  const wallet = getInjectedWallet();
  if (!wallet?.on) return undefined;

  const handleAccountsChanged = (accounts) => {
    const account =
      Array.isArray(accounts) && typeof accounts[0] === "string"
        ? accounts[0]
        : null;

    setWalletAccount(account);
    setWalletVerified(false);
    setWalletMessage(
      account
        ? "Account changed. Reconnect and verify the Portaldot V3 Testnet."
        : "Wallet disconnected."
    );
  };

  const handleChainChanged = () => {
    setWalletVerified(false);
    setWalletMessage(
      "Network changed. Reconnect to verify Portaldot V3 Testnet."
    );
  };

  wallet.on("accountsChanged", handleAccountsChanged);
  wallet.on("chainChanged", handleChainChanged);

  return () => {
    wallet.removeListener?.("accountsChanged", handleAccountsChanged);
    wallet.removeListener?.("chainChanged", handleChainChanged);
  };
}, []);

  const endpoint = getEndpoint(endpointId);

  useEffect(() => {
    let cancelled = false;
    let pollTimer = null;

    async function boot() {
      setStatus("connecting");
      setStatusMessage("");
      setChainInfo(null);
      setBestBlock(null);
      setFinalizedBlock(null);
      setBlockSamples([]);
      setHeadStats(null);
      lastHeadAtRef.current = null;

      try {
        const { connectApi, fetchChainInfo, fetchLatestBlockStats } = await import(
          "./lib/portaldot.js"
        );
        const { api } = await connectApi(endpoint);
        if (cancelled) {
          await api.disconnect();
          return;
        }
        apiRef.current = api;

        const info = await fetchChainInfo(api);
        if (cancelled) return;
        setChainInfo(info);
        setBestBlock(info.firstBlock);
        setStatus("connected");

        const stats = await fetchLatestBlockStats(api);
        if (!cancelled) setHeadStats(stats);

        unsubRef.current = await api.rpc.chain.subscribeNewHeads((header) => {
          if (pausedRef.current) return;
          const now = performance.now();
          if (lastHeadAtRef.current !== null) {
            const deltaSeconds = (now - lastHeadAtRef.current) / 1000;
            setBlockSamples((previous) => [...previous, deltaSeconds].slice(-MAX_BLOCK_SAMPLES));
          }
          lastHeadAtRef.current = now;
          setBestBlock(header.number.toNumber());
        });

        const pollFinalized = async () => {
          if (cancelled || !apiRef.current) return;
          try {
            const [hash, signedBlock] = await Promise.all([
              apiRef.current.rpc.chain.getFinalizedHead(),
              apiRef.current.rpc.chain.getBlock(),
            ]);
            if (cancelled) return;
            const finalizedHeader = await apiRef.current.rpc.chain.getHeader(hash);
            if (cancelled) return;
            setFinalizedBlock(finalizedHeader.number.toNumber());
            setHeadStats({
              number: signedBlock.block.header.number.toNumber(),
              extrinsicCount: signedBlock.block.extrinsics.length,
              sections: [],
            });
          } catch {
            /* transient RPC error, retry on next tick */
          }
        };

        await pollFinalized();
        pollTimer = setInterval(pollFinalized, FINALITY_POLL_MS);
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    }

    boot();

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (unsubRef.current) {
        try {
          unsubRef.current();
        } catch {
          /* ignore */
        }
        unsubRef.current = null;
      }
      if (apiRef.current) {
        apiRef.current.disconnect().catch(() => {});
        apiRef.current = null;
      }
    };
  }, [endpoint]);

  const runBenchmark = useCallback(async () => {
    setBenchmarking(true);
    try {
      const { benchmarkEndpoint } = await import("./lib/portaldot.js");
      const results = await Promise.all(ENDPOINTS.map((item) => benchmarkEndpoint(item)));
      setBenchmarks((previous) => {
        const next = { ...previous };
        results.forEach((result) => {
          next[result.endpointId] = result;
        });
        return next;
      });
    } finally {
      setBenchmarking(false);
    }
  }, []);

  const averageBlockTime = formatBlockTime(blockSamples);
  const finalityLag = bestBlock !== null && finalizedBlock !== null ? bestBlock - finalizedBlock : null;

  const handleEstimate = (event) => {
    event.preventDefault();
    setEstimating(true);
    setTimeout(() => {
      setEstimating(false);
      setEstimate({
        txs: stressCount,
        extrinsicsPerBlock: headStats?.extrinsicCount ?? null,
        note: "Client-side model based on the observed extrinsic count and block time. Nothing is broadcast.",
      });
    }, 400);
  };

  const handleSaveWebhook = (event) => {
    event.preventDefault();
    if (!webhookUrl) return;
    try {
      window.localStorage.setItem(WEBHOOK_STORAGE_KEY, webhookUrl);
    } catch {
      /* storage unavailable */
    }
    setWebhookSaved(true);
    setTimeout(() => setWebhookSaved(false), 3000);
  };

  const handleConnectWallet = async () => {
  setWalletMessage("");
  setWalletVerified(false);

  const wallet = getInjectedWallet();
  if (!wallet) {
    setWalletAccount(null);
    setWalletMessage("No injected EVM wallet was found. Install or unlock MetaMask, then retry.");
    return;
  }

  setWalletBusy(true);
  try {
    const accounts = await wallet.request({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
      throw new Error("The wallet did not return an account.");
    }

    await ensurePortaldotTestnet(wallet);

    setWalletAccount(accounts[0]);
    setWalletVerified(true);
    setWalletMessage("Wallet connected and verified on Portaldot V3 Testnet.");
  } catch (error) {
    setWalletAccount(null);
    setWalletVerified(false);
    setWalletMessage(error instanceof Error ? error.message : String(error));
  } finally {
    setWalletBusy(false);
  }
};

  const handleDeployProof = async () => {
    setWalletMessage("");
    const wallet = getInjectedWallet();
    if (!wallet || !walletAccount || !walletVerified) {
      setWalletMessage("Connect your wallet before deploying the proof contract.");
      return;
    }

    setWalletBusy(true);
    try {
      const deployment = await deployProofContract(
        wallet,
        walletAccount,
        PORTAPULSE_PROOF_BYTECODE,
      );
      const nextProof = { ...deployment, owner: walletAccount, pulseTxHash: null };
      setProof(nextProof);
      try {
        window.localStorage.setItem(PROOF_STORAGE_KEY, JSON.stringify(nextProof));
      } catch {
        setWalletMessage(
          `Deployment confirmed. Copy the contract address ${deployment.contractAddress} and transaction ${deployment.hash}; browser storage is unavailable.`,
        );
        return;
      }
      setWalletMessage("Contract deployed and confirmed on Portaldot V3 Testnet.");
    } catch (error) {
      setWalletMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWalletBusy(false);
    }
  };

  const handleSendProof = async () => {
    setWalletMessage("");
    const wallet = getInjectedWallet();
    if (!wallet || !walletAccount || !walletVerified || !proof?.contractAddress) {
      setWalletMessage("Connect your wallet and deploy the proof contract first.");
      return;
    }
    if (proof.owner.toLowerCase() !== walletAccount.toLowerCase()) {
      setWalletMessage("Reconnect the wallet that deployed this contract to send its proof transaction.");
      return;
    }

    setWalletBusy(true);
    try {
      const hash = await sendProofTransaction(
        wallet,
        walletAccount,
        proof.contractAddress,
        PORTAPULSE_PULSE_CALLDATA,
      );
      const nextProof = { ...proof, pulseTxHash: hash };
      setProof(nextProof);
      try {
        window.localStorage.setItem(PROOF_STORAGE_KEY, JSON.stringify(nextProof));
      } catch {
        setWalletMessage(`Pulse transaction confirmed. Copy the transaction hash ${hash}; browser storage is unavailable.`);
        return;
      }
      setWalletMessage("Pulse transaction confirmed on Portaldot V3 Testnet.");
    } catch (error) {
      setWalletMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWalletBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0E14] text-slate-100 p-4 md:p-8 font-sans selection:bg-[#00E599] selection:text-black">
      <header className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-tr from-[#00E599] to-[#6366F1] flex items-center justify-center shadow-lg shadow-[#00E599]/20">
            <Activity className="w-6 h-6 text-black" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-white">PortaPulse</h1>
              <span className="text-xs bg-emerald-500/10 text-[#00E599] border border-emerald-500/30 px-2 py-0.5 rounded-full font-mono">
                {chainInfo?.specVersion ? `Spec ${chainInfo.specVersion}` : "Portaldot"}
              </span>
            </div>
            <p className="text-xs text-slate-400">Node Operations &amp; Telemetry Suite for Portaldot</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <StatusPill status={status} chain={chainInfo?.chain} />

          <select
            value={endpointId}
            onChange={(event) => setEndpointId(event.target.value)}
            className="bg-[#151A23] border border-slate-800 text-xs text-slate-300 rounded-lg px-3 py-1.5 focus:outline-none focus:border-[#00E599]"
          >
            {ENDPOINTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>

          <button
            onClick={() => setPaused((value) => !value)}
            className="bg-[#151A23] hover:bg-slate-800 border border-slate-700 p-2 rounded-lg text-slate-300 transition"
            title={paused ? "Resume live updates" : "Pause live updates"}
          >
            <RefreshCw className={`w-4 h-4 ${paused ? "text-slate-400" : "text-[#00E599]"}`} />
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto mt-8 space-y-8">
        {status === "error" && (
          <div className="bg-rose-500/5 border border-rose-500/30 rounded-2xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div className="text-xs">
              <div className="text-rose-300 font-semibold">Could not connect to {endpoint.label}</div>
              <div className="text-slate-400 mt-1 font-mono">{statusMessage}</div>
            </div>
          </div>
        )}

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            label="LATEST BLOCK"
            icon={<Server className="w-4 h-4" />}
            iconColor="text-indigo-400"
            value={formatBlock(bestBlock)}
            footnote={
              finalityLag === null
                ? "Awaiting finalized head"
                : finalityLag === 0
                  ? "Head is finalized"
                  : `${finalityLag} block${finalityLag === 1 ? "" : "s"} behind finalized`
            }
            footnoteIcon={finalityLag === 0 ? CheckCircle2 : Clock}
          />

          <MetricCard
            label="AVG BLOCK TIME"
            icon={<Clock className="w-4 h-4" />}
            iconColor="text-emerald-400"
            value={averageBlockTime === null ? "—" : `${averageBlockTime.toFixed(2)}s`}
            footnote={
              averageBlockTime === null
                ? `Measuring… (${blockSamples.length}/${MAX_BLOCK_SAMPLES} samples)`
                : `Measured from ${blockSamples.length} observed heads`
            }
            footnoteIcon={Activity}
          />

          <MetricCard
            label="EXTRINSICS IN HEAD"
            icon={<Layers className="w-4 h-4" />}
            iconColor="text-amber-400"
            value={headStats ? String(headStats.extrinsicCount) : "—"}
            valueColor="text-[#00E599]"
            footnote={headStats ? `Block ${formatBlock(headStats.number)}` : "Awaiting first block"}
            footnoteIcon={Layers}
          />

          <MetricCard
            label="ACTIVE PEERS"
            icon={<Cpu className="w-4 h-4" />}
            iconColor="text-purple-400"
            value={chainInfo ? String(chainInfo.peers) : "—"}
            footnote={
              chainInfo
                ? chainInfo.isSyncing
                  ? "Node is syncing"
                  : `Synced • ${chainInfo.tokenSymbol}`
                : "Awaiting handshake"
            }
            footnoteIcon={ShieldCheck}
          />
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[#151A23] border border-slate-800 p-6 rounded-2xl">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Activity className="w-5 h-5 text-[#00E599]" />
                  RPC Connection Benchmark
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Measures a real WebSocket handshake plus one RPC round trip
                </p>
              </div>
              <button
                onClick={runBenchmark}
                disabled={benchmarking}
                className="bg-emerald-500/10 hover:bg-emerald-500/20 text-[#00E599] border border-emerald-500/30 text-xs font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${benchmarking ? "animate-spin" : ""}`} />
                {benchmarking ? "Testing…" : "Run Test"}
              </button>
            </div>

            <div className="space-y-3 mt-4">
              {ENDPOINTS.map((item) => {
                const result = benchmarks[item.id];
                return (
                  <div
                    key={item.id}
                    className="bg-[#0B0E14] border border-slate-800/80 p-3.5 rounded-xl flex items-center justify-between"
                  >
                    <div className="truncate max-w-[260px]">
                      <div className="text-xs font-mono text-slate-200 truncate">{item.label}</div>
                      <div className="text-[10px] text-slate-500 uppercase mt-0.5">
                        {result?.ok ? result.chain : result ? result.error : "Not tested yet"}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm font-bold text-white">
                        {result ? `${result.ms} ms` : "—"}
                      </span>
                      <span
                        className={`w-2.5 h-2.5 rounded-full ${
                          !result
                            ? "bg-slate-600"
                            : !result.ok
                              ? "bg-rose-400"
                              : result.ms < 1500
                                ? "bg-emerald-400"
                                : result.ms < 4000
                                  ? "bg-amber-400"
                                  : "bg-rose-400"
                        }`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-[#151A23] border border-slate-800 p-6 rounded-2xl">
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Flame className="w-5 h-5 text-amber-400" />
                Batch Load Planner
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Sizes a transaction batch against live observed head data
              </p>
            </div>

            <div className="mt-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Planned Transaction Load</label>
                <div className="flex gap-2">
                  {[5, 10, 25, 50].map((num) => (
                    <button
                      key={num}
                      onClick={() => setStressCount(num)}
                      className={`flex-1 py-1.5 text-xs rounded-lg border font-mono transition ${
                        stressCount === num
                          ? "bg-[#00E599]/10 border-[#00E599] text-[#00E599] font-bold"
                          : "bg-[#0B0E14] border-slate-800 text-slate-400 hover:border-slate-700"
                      }`}
                    >
                      {num} txs
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={handleEstimate}
                disabled={estimating}
                className="w-full bg-gradient-to-r from-[#00E599] to-[#6366F1] hover:opacity-90 text-black font-semibold py-2.5 rounded-xl text-xs flex items-center justify-center gap-2 transition disabled:opacity-50"
              >
                <Send className="w-4 h-4 text-black" />
                {estimating ? "Planning…" : `Plan Batch of ${stressCount} Txs`}
              </button>

              {estimate && (
                <div className="bg-[#0B0E14] border border-emerald-500/20 p-4 rounded-xl text-xs space-y-1.5 font-mono">
                  <div className="text-[#00E599] font-semibold flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4" /> Plan Ready
                  </div>
                  <div className="text-slate-400">
                    Planned: <span className="text-slate-200">{estimate.txs} transactions</span>
                  </div>
                  <div className="text-slate-400">
                    Observed head size:{" "}
                    <span className="text-slate-200">
                      {estimate.extrinsicsPerBlock === null
                        ? "unavailable"
                        : `${estimate.extrinsicsPerBlock} extrinsic${estimate.extrinsicsPerBlock === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  <div className="text-slate-400">
                    Est. blocks to clear:{" "}
                    <span className="text-slate-200">
                      {estimate.extrinsicsPerBlock
                        ? Math.ceil(estimate.txs / estimate.extrinsicsPerBlock)
                        : "—"}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-500 pt-1 leading-relaxed">{estimate.note}</div>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="bg-[#151A23] border border-slate-800 p-6 rounded-2xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Wallet className="w-5 h-5 text-[#00E599]" />
                Testnet Wallet &amp; On-chain Proof
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Connect MetaMask, verify Portaldot V3 Testnet, deploy the proof contract, and submit a signed pulse transaction. No private key is requested or stored.
              </p>
              <div className="mt-2 space-y-1 text-[11px] text-slate-500">
  <p>You'll need testnet tPOT for transaction gas.</p>
  <p>MetaMask uses an EVM address (0x...). Hackathon registration may require your native SS58 address (5...).</p>
</div>
            </div>
            <button
              onClick={handleConnectWallet}
              disabled={walletBusy}
              className="shrink-0 bg-emerald-500/10 hover:bg-emerald-500/20 text-[#00E599] border border-emerald-500/30 text-xs font-semibold px-4 py-2 rounded-lg transition disabled:opacity-50"
            >
              {walletBusy
  ? "Connecting…"
  : walletVerified && walletAccount
    ? `${walletAccount.slice(0, 6)}…${walletAccount.slice(-4)} ✓`
    : walletAccount
      ? "Verify network"
      : "Connect MetaMask"}
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs">
  <span
    className={`h-2 w-2 rounded-full ${
      walletVerified
        ? "bg-emerald-400"
        : walletAccount
          ? "bg-amber-400"
          : "bg-slate-500"
    }`}
  />
  <span className="text-slate-400">
    {walletVerified
      ? "Connected · Portaldot V3 Testnet verified"
      : walletAccount
        ? "Account detected · Network verification required"
        : "Wallet not connected"}
  </span>
</div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button
              onClick={handleDeployProof}
              disabled={walletBusy || !walletAccount || !walletVerified || Boolean(proof?.contractAddress)}
              className="bg-[#0B0E14] border border-slate-800 hover:border-[#00E599]/60 rounded-xl p-4 text-left transition disabled:opacity-50"
            >
              <span className="block text-xs font-semibold text-slate-200">1. Deploy proof contract</span>
              <span className="block text-[11px] text-slate-500 mt-1">
                Requires a wallet confirmation and testnet gas.
              </span>
            </button>
            <button
              onClick={handleSendProof}
              disabled={walletBusy || !walletAccount || !walletVerified || !proof?.contractAddress || Boolean(proof?.pulseTxHash)}
              className="bg-[#0B0E14] border border-slate-800 hover:border-[#00E599]/60 rounded-xl p-4 text-left transition disabled:opacity-50"
            >
              <span className="block text-xs font-semibold text-slate-200">2. Send on-chain pulse</span>
              <span className="block text-[11px] text-slate-500 mt-1">
                A separate signed transaction records the demo interaction.
              </span>
            </button>
          </div>

          {proof?.contractAddress && (
            <div className="mt-4 space-y-2 rounded-xl border border-slate-800/80 bg-[#0B0E14] p-3.5 text-xs font-mono">
              <div className="break-all text-slate-300">Contract: {proof.contractAddress}</div>
              <div className="break-all text-slate-500">Deployment tx: {proof.hash}</div>
              {proof.pulseTxHash && (
                <div className="break-all text-slate-500">Pulse tx: {proof.pulseTxHash}</div>
              )}
              <a
                className="inline-block text-[#00E599] hover:underline"
                href={PORTALDOT_TESTNET.explorer}
                target="_blank"
                rel="noreferrer"
              >
                Verify on Node Explorer
              </a>
            </div>
          )}
          {walletMessage && (
            <div className="mt-3 text-xs text-slate-300" role="status" aria-live="polite">
              {walletMessage}
            </div>
          )}
        </section>

        <section className="bg-[#151A23] border border-slate-800 p-6 rounded-2xl">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Bell className="w-5 h-5 text-indigo-400" />
                Validator &amp; Node Heartbeat Alert
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Stores a webhook endpoint locally for a heartbeat worker to deliver downtime alerts.
              </p>
            </div>

            <form onSubmit={handleSaveWebhook} className="flex gap-2 w-full md:w-auto">
              <input
                type="text"
                placeholder="https://discord.com/api/webhooks/..."
                value={webhookUrl}
                onChange={(event) => setWebhookUrl(event.target.value)}
                className="bg-[#0B0E14] border border-slate-800 text-xs text-slate-200 px-3.5 py-2 rounded-xl focus:outline-none focus:border-[#00E599] w-full md:w-80"
              />
              <button
                type="submit"
                className="bg-[#151A23] hover:bg-slate-800 border border-slate-700 text-xs px-4 py-2 rounded-xl text-slate-200 font-medium transition"
              >
                Save
              </button>
            </form>
          </div>
          {webhookSaved && (
            <div className="mt-3 text-xs text-[#00E599] flex items-center gap-1.5 font-mono">
              <CheckCircle2 className="w-3.5 h-3.5" /> Webhook endpoint saved in this browser.
            </div>
          )}
          <div className="mt-3 text-[11px] text-slate-500 font-mono">
            Delivery requires a background worker; this dashboard only persists the endpoint locally.
          </div>
        </section>

        <section className="bg-[#151A23] border border-slate-800 p-6 rounded-2xl">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            Chain Details
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4 text-xs font-mono">
            {[
              ["Chain", chainInfo?.chain],
              ["Client", chainInfo?.client],
              ["Runtime spec", chainInfo?.specVersion],
              ["Token", chainInfo ? `${chainInfo.tokenSymbol} (${chainInfo.tokenDecimals} decimals)` : null],
              ["SS58 prefix", chainInfo?.ss58Format],
              ["Finalized head", finalizedBlock === null ? null : formatBlock(finalizedBlock)],
            ].map(([label, value]) => (
              <div key={label} className="bg-[#0B0E14] border border-slate-800/80 p-3.5 rounded-xl">
                <div className="text-[10px] text-slate-500 uppercase">{label}</div>
                <div className="text-slate-200 mt-1 truncate">{value ?? "—"}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-slate-800/80 bg-[#0B0E14] p-3.5 text-xs font-mono">
            <div className="text-[10px] text-slate-500 uppercase">Portaldot V3 Testnet · EVM</div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-slate-300">
              <span>Chain ID: {PORTALDOT_TESTNET.chainId}</span>
              <a
                className="break-all text-[#00E599] hover:underline"
                href={PORTALDOT_TESTNET.evmRpc}
                target="_blank"
                rel="noreferrer"
              >
                {PORTALDOT_TESTNET.evmRpc}
              </a>
              <a
                className="text-[#00E599] hover:underline"
                href={PORTALDOT_TESTNET.explorer}
                target="_blank"
                rel="noreferrer"
              >
                Node Explorer
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="max-w-7xl mx-auto mt-12 pt-6 border-t border-slate-800/80 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-3">
        <div>Built for Portaldot Hacker House 2026 • Track 3 (Node Operations &amp; Tooling)</div>
        <div className="flex items-center gap-4">
          <span className="font-mono">Live data via @polkadot/api</span>
          <span className="font-mono">Open Source (MIT)</span>
        </div>
      </footer>
    </div>
  );
}
