/**
 * Bumped whenever alias data or matching semantics change. Stored on every
 * recommendation so a historical result can be attributed to the taxonomy
 * behaviour of its day.
 */
export const TAXONOMY_VERSION = "2026-07-token-aliases-v1";

export type LineOfBusiness = "personal" | "commercial" | "both";

export interface TaxonomyEntry {
  key: string;
  display_name: string;
  line_of_business: LineOfBusiness;
  aliases: string[];
}

const ENTRIES: TaxonomyEntry[] = [
  {
    key: "motor",
    display_name: "Motor",
    line_of_business: "both",
    aliases: ["motor", "vehicle", "vehicles", "private motor", "motor private", "private_vehicle", "private vehicle"],
  },
  {
    key: "commercial_motor",
    display_name: "Commercial Motor",
    line_of_business: "commercial",
    aliases: ["commercial motor", "commercial vehicle", "commercial vehicles", "commercial_vehicle", "fleet", "hcv", "ldv", "trucks"],
  },
  {
    key: "goods_in_transit",
    display_name: "Goods In Transit",
    line_of_business: "commercial",
    aliases: ["goods in transit", "git", "goods_in_transit", "transit"],
  },
  {
    key: "business_all_risks",
    display_name: "Business All Risks",
    line_of_business: "commercial",
    aliases: ["business all risks", "bar", "business_all_risks", "all risks"],
  },
  {
    key: "public_liability",
    display_name: "Public Liability",
    line_of_business: "both",
    aliases: ["public liability", "general and tenants liability", "general & tenants liability", "g&t", "g and t", "liability"],
  },
  {
    key: "buildings",
    display_name: "Buildings",
    line_of_business: "both",
    aliases: ["buildings", "building", "fire", "commercial property", "property", "commercial_property"],
  },
  {
    key: "contents",
    display_name: "Contents",
    line_of_business: "both",
    aliases: ["contents", "office contents", "business contents", "office_contents"],
  },
  {
    key: "electronic_equipment",
    display_name: "Electronic Equipment",
    line_of_business: "commercial",
    aliases: ["electronic equipment", "ee", "computers", "electronic_equipment"],
  },
  {
    key: "theft",
    display_name: "Theft",
    line_of_business: "commercial",
    aliases: ["theft", "burglary"],
  },
  {
    key: "sectional_title",
    display_name: "Sectional Title",
    line_of_business: "personal",
    aliases: ["sectional title", "body corporate", "body_corporate", "st"],
  },
];

const aliasToKey = new Map<string, string>();
for (const entry of ENTRIES) {
  aliasToKey.set(normalizeLoose(entry.key), entry.key);
  for (const alias of entry.aliases) aliasToKey.set(normalizeLoose(alias), entry.key);
}

// Alias list for the token-based fallback, ordered scan with best-match-wins.
const ALIAS_ENTRIES: { aliasLoose: string; key: string; tokenCount: number }[] = [
  ...aliasToKey.entries(),
].map(([aliasLoose, key]) => ({
  aliasLoose,
  key,
  tokenCount: aliasLoose.split(" ").filter(Boolean).length,
}));

/**
 * Short single-token aliases ("st", "ee", "bar", "git", …) are landmines under
 * fuzzy matching: as substrings OR as loose tokens they hit unrelated words
 * ("storage" → sectional title, "digital" → goods in transit). They therefore
 * only ever match when the WHOLE normalized value equals the alias.
 */
const SHORT_ALIAS_MAX_LENGTH = 3;

export function normalizeLoose(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[_\-/]+/g, " ")
    .replace(/[^a-z0-9* ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does this alias describe the value? Word-boundary semantics, never raw
 * substrings: every alias token must appear as a whole token of the value.
 * ("fire" matches "fire and allied perils" but not "misfire prevention".)
 */
function aliasMatchesValue(aliasLoose: string, valueLoose: string, valueTokens: Set<string>): boolean {
  if (!aliasLoose) return false;
  if (aliasLoose === valueLoose) return true;
  const aliasTokens = aliasLoose.split(" ").filter(Boolean);
  if (aliasTokens.length === 1 && aliasLoose.length <= SHORT_ALIAS_MAX_LENGTH) return false;
  return aliasTokens.every((t) => valueTokens.has(t));
}

export function canonicalTaxonomyKey(value: string): string {
  const loose = normalizeLoose(value);
  if (!loose) return "";
  if (loose === "*") return "*";
  const exact = aliasToKey.get(loose);
  if (exact) return exact;

  // Token-based fallback: the most specific alias (most tokens, then longest
  // text) whose every token appears in the value wins. No substring matching —
  // that's what produced silent misclassification ("storage" → sectional
  // title via "st"), which changes which appetite rule scores an insurer.
  const valueTokens = new Set(loose.split(" ").filter(Boolean));
  let best: { key: string; tokenCount: number; length: number } | null = null;
  for (const entry of ALIAS_ENTRIES) {
    if (!aliasMatchesValue(entry.aliasLoose, loose, valueTokens)) continue;
    if (
      !best ||
      entry.tokenCount > best.tokenCount ||
      (entry.tokenCount === best.tokenCount && entry.aliasLoose.length > best.length)
    ) {
      best = { key: entry.key, tokenCount: entry.tokenCount, length: entry.aliasLoose.length };
    }
  }
  if (best) return best.key;
  return loose.replace(/\s+/g, "_");
}

/**
 * Are two canonical keys the same product family? Equality, or one key's
 * underscore-token set fully contained in the other's ("motor" relates to
 * "commercial_motor"; "risk" does NOT relate to "business_all_risks").
 * Used by the matcher instead of raw substring containment on keys.
 */
export function taxonomyKeysRelated(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const at = a.split("_").filter(Boolean);
  const bt = b.split("_").filter(Boolean);
  if (at.length === 0 || bt.length === 0) return false;
  const aset = new Set(at);
  const bset = new Set(bt);
  return at.every((t) => bset.has(t)) || bt.every((t) => aset.has(t));
}

export function canonicalizeMany(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = canonicalTaxonomyKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function taxonomyDisplayName(key: string): string {
  const entry = ENTRIES.find((x) => x.key === key);
  return entry?.display_name ?? key.replace(/_/g, " ");
}

export function nearbyTaxonomyMatches(value: string, candidates: string[], limit = 5): string[] {
  const key = canonicalTaxonomyKey(value);
  const loose = normalizeLoose(value);
  const scored = candidates
    .map((candidate) => {
      const candidateKey = canonicalTaxonomyKey(candidate);
      const candidateLoose = normalizeLoose(candidate);
      let score = 0;
      if (candidateKey === key) score += 4;
      if (candidateLoose.includes(loose) || loose.includes(candidateLoose)) score += 2;
      if (candidateKey.includes(key) || key.includes(candidateKey)) score += 1;
      return { candidate, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.candidate);
}
