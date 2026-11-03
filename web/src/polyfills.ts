// Wallet modules expect Node's Buffer (HERE) and process (Meteor). Imported before anything else.
import { Buffer } from "buffer";

const g = globalThis as unknown as {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
  process?: { env: Record<string, string>; browser: boolean; version: string; nextTick(fn: () => void): void };
};
g.Buffer ??= Buffer;
g.global ??= globalThis;
g.process ??= { env: {}, browser: true, version: "", nextTick: (fn) => queueMicrotask(fn) };
