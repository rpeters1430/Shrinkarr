import type { LibraryRule, LibraryRuleCondition, Preset } from "./api/client";

function values(value: LibraryRuleCondition["value"]): unknown[] {
  return Array.isArray(value) ? value : [value];
}

export function validateLibraryRules(rules: LibraryRule[], presets: Preset[], scanKind: "video" | "audio" = "video"): string | null {
  if (rules.length > 100) return "A library can have at most 100 rules.";
  const ids = new Set<string>();
  for (const [ruleIndex, rule] of rules.entries()) {
    if (!rule.id.trim() || ids.has(rule.id)) return `Rule ${ruleIndex + 1} must have a unique ID.`;
    ids.add(rule.id);
    if (!rule.name.trim()) return `Rule ${ruleIndex + 1} needs a name.`;
    if (rule.conditions.length < 1 || rule.conditions.length > 16) return `Rule “${rule.name}” must have between 1 and 16 conditions.`;
    for (const [conditionIndex, condition] of rule.conditions.entries()) {
      const label = `Rule “${rule.name}”, condition ${conditionIndex + 1}`;
      const items = values(condition.value);
      if (condition.field === "isHdr") {
        if (condition.operator !== "equals" || typeof condition.value !== "boolean") return `${label} needs an HDR or SDR value.`;
      } else if (condition.field === "mediaKind") {
        if (condition.operator !== "equals" && condition.operator !== "oneOf") return `${label} has an unsupported operator.`;
        if (items.length === 0 || items.some((item) => item !== "video" && item !== "audio")) return `${label} must use “video” or “audio”.`;
        if (condition.operator === "equals" && items.length !== 1) return `${label} needs one media kind.`;
        if (!items.includes(scanKind)) return `${label} targets media this library scan does not index.`;
      } else if (["path", "videoCodec", "audioCodec", "container"].includes(condition.field)) {
        const allowed = condition.field === "path"
          ? ["equals", "oneOf", "contains", "glob"]
          : ["equals", "oneOf", "contains"];
        if (!allowed.includes(condition.operator)) return `${label} has an unsupported operator.`;
        if (items.length === 0 || items.some((item) => typeof item !== "string" || !item.trim())) return `${label} needs a non-empty text value.`;
        if (condition.operator !== "oneOf" && items.length !== 1) return `${label} needs a single text value.`;
      } else {
        const allowed = ["equals", "oneOf", "greaterThan", "lessThan", "between"];
        if (!allowed.includes(condition.operator)) return `${label} has an unsupported operator.`;
        if (items.length === 0 || items.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) return `${label} needs non-negative numeric values.`;
        const numericItems = items as number[];
        if (condition.field === "bitDepth" && numericItems.some((item) => !Number.isInteger(item) || item <= 0)) return `${label} needs positive whole-number bit depths.`;
        if (["width", "height", "audioChannels", "subtitleCount"].includes(condition.field) && numericItems.some((item) => !Number.isInteger(item))) return `${label} needs whole-number values.`;
        if (condition.operator === "between" && (numericItems.length !== 2 || numericItems[0] > numericItems[1])) return `${label} needs two ordered bounds for “between”.`;
        if (condition.operator !== "oneOf" && condition.operator !== "between" && items.length !== 1) return `${label} needs a single number.`;
      }
    }
    if (rule.action.type === "preset") {
      const presetId = rule.action.presetId;
      const preset = presets.find((item) => item.id === presetId);
      if (!preset) return `Rule “${rule.name}” refers to a missing preset.`;
      if ((preset.mediaKind ?? "video") !== scanKind) return `The “${preset.name}” preset does not match this library’s scan type.`;
      const kind = rule.conditions.find((condition) => condition.field === "mediaKind");
      const kinds = kind ? values(kind.value) : [];
      if (!kinds.includes(preset.mediaKind ?? "video")) return `Add a media kind condition compatible with the “${preset.name}” preset.`;
    }
  }
  return null;
}
