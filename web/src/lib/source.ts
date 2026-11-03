// One interface over the live contract and the demo data.

import { demoStore } from "./demo";
import { view } from "./near";
import type { Application, AuditCopy, Basis, Config, Purchase, Round, Submission } from "./types";

export type Source = {
  config(): Promise<Config>;
  members(): Promise<string[]>;
  rounds(): Promise<Round[]>;
  round(id: string): Promise<Round | null>;
  submissions(id: string): Promise<Submission[]>;
  purchasesOf(account: string): Promise<Purchase[]>;
  earnings(account: string): Promise<string>;
  applications(): Promise<Application[]>;
  auditorOf(fund: string): Promise<string | null>;
  clientsOf(auditor: string): Promise<string[]>;
  auditsOf(auditor: string): Promise<AuditCopy[]>;
  /** Why `account` may read a published round for free, or null if it pays. */
  freeBasis(roundId: string, account: string): Promise<Basis | null>;
};

const PAGE = 50;

export const live: Source = {
  config: () => view("get_config"),
  members: () => view("get_members"),
  async rounds() {
    const all: Round[] = [];
    for (let from = 0; ; from += PAGE) {
      const page = await view<Round[]>("get_rounds", { from_index: from, limit: PAGE });
      all.push(...page);
      if (page.length < PAGE) return all;
    }
  },
  round: (id) => view("get_round", { round_id: id }),
  submissions: (id) => view("get_submissions", { round_id: id }),
  purchasesOf: (account) => view("get_purchases_of", { buyer: account }),
  earnings: (account) => view("get_earnings", { account }),
  applications: () => view("get_applications"),
  auditorOf: (fund) => view("get_auditor", { fund }),
  clientsOf: (auditor) => view("get_clients_of", { auditor }),
  auditsOf: (auditor) => view("get_audits_of", { auditor }),
  freeBasis: (roundId, account) => view("get_free_basis", { round_id: roundId, account }),
};

export const demo: Source = {
  config: async () => (await demoStore()).config,
  members: async () => (await demoStore()).members,
  rounds: async () => (await demoStore()).rounds,
  round: async (id) => (await demoStore()).rounds.find((r) => r.id === id) ?? null,
  submissions: async (id) => (await demoStore()).submissions[id] ?? [],
  purchasesOf: async (account) => (await demoStore()).purchases.filter((p) => p.buyer === account),
  earnings: async (account) => (await demoStore()).earnings[account] ?? "0",
  applications: async () => (await demoStore()).applications,
  auditorOf: async (fund) => (await demoStore()).auditors[fund] ?? null,
  clientsOf: async (auditor) => {
    const { auditors, members } = await demoStore();
    return members.filter((m) => auditors[m] === auditor);
  },
  auditsOf: async (auditor) => (await demoStore()).audits.filter((a) => a.auditor === auditor),
  async freeBasis(roundId, account) {
    const { rounds, auditors } = await demoStore();
    const counted = rounds.find((r) => r.id === roundId && r.status === "Published")?.listing?.contributors ?? [];
    if (counted.includes(account)) return "Contributed";
    return counted.some((c) => auditors[c] === account) ? "Audit" : null;
  },
};
