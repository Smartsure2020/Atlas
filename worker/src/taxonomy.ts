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

export function normalizeLoose(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[_\-/]+/g, " ")
    .replace(/[^a-z0-9* ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalTaxonomyKey(value: string): string {
  const loose = normalizeLoose(value);
  if (!loose) return "";
  if (loose === "*") return "*";
  if (aliasToKey.has(loose)) return aliasToKey.get(loose)!;

  for (const [alias, key] of aliasToKey) {
    if (alias && (loose.includes(alias) || alias.includes(loose))) return key;
  }
  return loose.replace(/\s+/g, "_");
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
