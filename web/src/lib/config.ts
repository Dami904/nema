// `import.meta.env` is undefined when the test script imports this under plain Node.
const env: Record<string, unknown> = import.meta.env ?? {};

export const CONFIG = {
  network: (env.VITE_NEAR_NETWORK as string | undefined) ?? "testnet",
  rpc: (env.VITE_NEAR_RPC as string | undefined) ?? "https://rpc.testnet.fastnear.com",
  /** Keeps old transactions; the ordinary RPC drops them after a few days. */
  archivalRpc: (env.VITE_NEAR_ARCHIVAL_RPC as string | undefined) ?? "https://archival-rpc.testnet.fastnear.com",
  contract: (env.VITE_NEMA_CONTRACT as string | undefined) ?? "nema-v2.testnet",
  /** The account the test funds, lender and council seats are sub-accounts of. */
  accountsBase: (env.VITE_NEMA_ACCOUNTS as string | undefined) ?? "nema-dev.testnet",
  explorerTx: (env.VITE_EXPLORER_TX as string | undefined) ?? "https://testnet.nearblocks.io/txns/",
  explorerAccount: (env.VITE_EXPLORER_ACCOUNT as string | undefined) ?? "https://testnet.nearblocks.io/address/",
  /** Lists an account's recent transactions, to find one a wallet lost track of. */
  txApi: (env.VITE_TX_API as string | undefined) ?? "https://tx.test.fastnear.com",
};

/** The public repository, linked from the footer once it is set. */
export const REPO_URL = (env.VITE_REPO_URL as string | undefined) ?? "";

/** Builds we expect on chain, so the Docs page can compare them. */
export const BUILDS = {
  contractWasmSha256: "36e01373109545d27c46a36bf0d0ab39745f18b3c5f8b90a92cb02cdf41c7694",
  /** The commit that build came from; `contract_source_metadata` on chain names it too. */
  contractSourceRev: "d8f5b5867a1d9196251b984fe32572b758788ff3",
  /** Rounded, trimmed results; built in the pinned container (aggregator/build.sh). */
  enclaveWasmSha256: "f317370983fab3385e1f60c2c4958a4fccb935e030fcf06c35b9f6e9b0514bc8",
  /** Earlier builds whose runs are still genuine: the rounds they tallied published exact results. */
  earlierEnclaveWasmSha256: ["3ed58517795dc12a8f749b4ce92c747a47cbdb7ded3d383465d042060fe750d6"],
  /**
   * The last round on the contract that the earlier builds ran. A run of an earlier
   * build on a later round fails the check, so a switch back to the exact enclave
   * can't pass as genuine.
   */
  earlierEnclaveLastRound: 2,
  enclaveProject: "nema-dev.testnet/nema-aggregator",
};

/** Two hosts serve the same enclave bytes; the OutLayer project loads one (`pnpm live:enclave-source`). */
export const ENCLAVE_URLS = {
  fastfs: `https://test.fastfs.io/nema-dev.testnet/outlayer.testnet/${BUILDS.enclaveWasmSha256}.wasm`,
  github: "https://github.com/Dami904/nema/releases/download/enclave-v3/nema-aggregator.wasm",
};

/** OutLayer's minimum deposit for one enclave call, on top of the read price. */
export const ENCLAVE_FEE_YOCTO = 10n ** 22n;
/** Kept by the contract on every read and audit, for the record it stores. */
export const STORAGE_DEPOSIT_YOCTO = 2n * 10n ** 22n;
/** What a read or an audit attaches on top of any read price. */
export const READ_EXTRA_YOCTO = ENCLAVE_FEE_YOCTO + STORAGE_DEPOSIT_YOCTO;
/** Attached to a submission: covers the largest mark's storage; the rest comes back. */
export const SUBMIT_DEPOSIT_YOCTO = 3n * 10n ** 22n;

export const POLL_MS = 15_000;
/** How long the contract waits on the enclave before anyone may settle a call (STALE_AFTER_NS). */
export const STALE_AFTER_MS = 30 * 60_000;
