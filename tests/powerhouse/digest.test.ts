/**
 * Powerhouse Batch B — the synchronous SHA-256 behind contradiction identities and
 * the recommendation fingerprint. Checked against the FIPS 180-4 vectors and
 * against Node's own implementation on adversarial lengths (padding boundaries).
 */

import { createHash } from "node:crypto";
import { sha256Hex } from "../../worker/src/digest.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function eq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

test("1. FIPS 180-4 vectors", () => {
  eq(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "empty");
  eq(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "abc");
  eq(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    "two-block message"
  );
  eq(sha256Hex("a".repeat(1_000_000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0", "one million a");
});

test("2. agrees with Node on every length around the padding boundaries and on multi-byte text", () => {
  const reference = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  for (let length = 0; length <= 200; length++) {
    const text = "x".repeat(length);
    eq(sha256Hex(text), reference(text), `length ${length}`);
  }
  for (const text of ["é", "naïve café", "名前", "emoji 😀 test", "\u0000nul\u0000", "a\r\nb", "•••@•••.za"]) {
    eq(sha256Hex(text), reference(text), JSON.stringify(text));
  }
  let state = 7;
  for (let i = 0; i < 300; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const text = Array.from({ length: state % 180 }, (_, index) => String.fromCharCode(32 + ((state >>> (index % 20)) % 95))).join("");
    eq(sha256Hex(text), reference(text), `random ${i}`);
  }
});

test("3. deterministic, 64 lowercase hex characters, and sensitive to a single character", () => {
  const a = sha256Hex("atlas");
  eq(a, sha256Hex("atlas"), "stable");
  eq(/^[0-9a-f]{64}$/.test(a), true, "shape");
  eq(a === sha256Hex("Atlas"), false, "case sensitive");
});

let failures = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok - ${item.name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${item.name}`);
    console.error((error as Error).message);
  }
}
console.log(`\nPowerhouse digest: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
