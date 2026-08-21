export const WORKFLOW_LISTS = [
  { name: "Pending", type: "active" },
  { name: "Needs your decision", type: "active" },
  { name: "In worktree", type: "active" },
  { name: "Test it", type: "active" },
  { name: "Review in main", type: "active" },
  { name: "Merged", type: "closed" },
];

export const WORKFLOW_LABELS = [
  { name: "needs-decision", color: "apricot-red" },
  { name: "decided", color: "modern-green" },
  { name: "tested-ok", color: "french-coast" },
  { name: "fast-track", color: "sunny-grass" },
  { name: "standard", color: "morning-sky" },
  { name: "serial", color: "red-burgundy" },
  { name: "zone:frontend", color: "pink-tulip" },
  { name: "zone:backend", color: "lagoon-blue" },
  { name: "zone:data", color: "egg-yellow" },
  { name: "zone:infra", color: "dark-granite" },
  { name: "zone:shared-ui", color: "sweet-lilac" },
];

export function nextPosition(index) {
  return (index + 1) * 65536;
}
