import assert from "node:assert/strict";
import test from "node:test";
import { createWalletConnectionHandler } from "./wallet-connection.js";

const ACCOUNT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TARGET_CHAIN = "0x190f1ca9";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup({ ensureNetwork = async () => {}, onAccountsRequest } = {}) {
  const walletAttemptRef = { current: 0 };
  const walletEventAccountRef = { current: null };
  const walletEventSeenRef = { current: false };
  const state = {
    account: null,
    verified: false,
    busy: false,
    message: "",
  };

  const wallet = {
    async request({ method }) {
      if (method === "eth_requestAccounts") {
        onAccountsRequest?.();
        return [ACCOUNT_A];
      }
      if (method === "eth_accounts") return [ACCOUNT_A];
      if (method === "eth_chainId") return TARGET_CHAIN;
      throw new Error(`Unexpected wallet request: ${method}`);
    },
  };

  const handleConnectWallet = createWalletConnectionHandler({
    walletAttemptRef,
    walletEventAccountRef,
    walletEventSeenRef,
    getInjectedWallet: () => wallet,
    ensurePortaldotTestnet: ensureNetwork,
    targetChainId: TARGET_CHAIN,
    setWalletAccount: (value) => { state.account = value; },
    setWalletVerified: (value) => { state.verified = value; },
    setWalletBusy: (value) => { state.busy = value; },
    setWalletMessage: (value) => { state.message = value; },
  });

  return {
    handleConnectWallet,
    walletAttemptRef,
    walletEventAccountRef,
    walletEventSeenRef,
    state,
  };
}

test("does not verify account A if the account changes to B during network verification", async () => {
  const gate = deferred();
  const app = setup({ ensureNetwork: () => gate.promise });

  const connection = app.handleConnectWallet();
  await new Promise((resolve) => setImmediate(resolve));

  app.walletAttemptRef.current += 1;
  app.walletEventSeenRef.current = true;
  app.walletEventAccountRef.current = ACCOUNT_B;
  app.state.account = ACCOUNT_B;
  app.state.verified = false;
  app.state.busy = false;

  gate.resolve();
  await connection;

  assert.equal(app.state.account, ACCOUNT_B);
  assert.equal(app.state.verified, false);
  assert.equal(app.state.busy, false);
});

test("does not restore account A after the wallet disconnects during verification", async () => {
  const gate = deferred();
  const app = setup({ ensureNetwork: () => gate.promise });

  const connection = app.handleConnectWallet();
  await new Promise((resolve) => setImmediate(resolve));

  app.walletAttemptRef.current += 1;
  app.walletEventSeenRef.current = true;
  app.walletEventAccountRef.current = null;
  app.state.account = null;
  app.state.verified = false;
  app.state.busy = false;

  gate.resolve();
  await connection;

  assert.equal(app.state.account, null);
  assert.equal(app.state.verified, false);
  assert.equal(app.state.busy, false);
});

test("accepts the matching accountsChanged event during initial wallet approval", async () => {
  const app = setup({
    onAccountsRequest: () => {
      app.walletEventSeenRef.current = true;
      app.walletEventAccountRef.current = ACCOUNT_A;
      app.walletAttemptRef.current += 1;
    },
  });

  await app.handleConnectWallet();

  assert.equal(app.state.account, ACCOUNT_A);
  assert.equal(app.state.verified, true);
  assert.equal(app.state.busy, false);
});

test("completes verification after a normal network switch", async () => {
  const app = setup({
    ensureNetwork: async () => {
      // A normal chainChanged event does not invalidate the connection attempt.
    },
  });

  await app.handleConnectWallet();

  assert.equal(app.state.account, ACCOUNT_A);
  assert.equal(app.state.verified, true);
  assert.equal(app.state.busy, false);
  assert.match(app.state.message, /connected and verified/);
});
