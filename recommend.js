import os from "os";

const TIERS = [
  { maxGb: 11, model: "llama3.2:3b",   size: "~2 GB",  note: "Lightweight — for low-RAM systems." },
  { maxGb: 22, model: "llama3.1:8b",   size: "~5 GB",  note: "Sweet spot for 12–22 GB systems." },
  { maxGb: 40, model: "qwen2.5:14b",   size: "~9 GB",  note: "Balanced — wants ~24 GB headroom." },
  { maxGb: Infinity, model: "qwen2.5:32b", size: "~20 GB", note: "Heavier — for 48 GB+ systems." },
];

export function recommendModel(totalMemBytes = os.totalmem()) {
  const ramGb = Math.round(totalMemBytes / (1024 ** 3));
  const i = TIERS.findIndex(t => ramGb <= t.maxGb);
  const tier = TIERS[i];
  return {
    ramGb,
    recommended: tier.model,
    size: tier.size,
    note: tier.note,
    lighter: TIERS[i - 1]?.model || null,
    heavier: TIERS[i + 1]?.model || null,
  };
}
