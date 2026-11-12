/**
 * Shared character calculation utilities used by both tools and resources.
 * These are the canonical implementations for ability scores, AC, HP, and level.
 */

import type {
  DdbCharacter,
  DdbAbilityScore,
  DdbModifier,
  DdbSpell,
} from "../types/character.js";

export const ABILITY_NAMES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];

// Maps stat ID (1-6) to the subType prefix used in D&D Beyond modifiers
export const ABILITY_SUBTYPE_MAP: Record<number, string> = {
  1: "strength-score",
  2: "dexterity-score",
  3: "constitution-score",
  4: "intelligence-score",
  5: "wisdom-score",
  6: "charisma-score",
};

export function calculateAbilityModifier(score: number): string {
  const modifier = Math.floor((score - 10) / 2);
  return modifier >= 0 ? `+${modifier}` : `${modifier}`;
}

export function sumModifierBonuses(
  modifiers: Record<string, DdbModifier[]>,
  subType: string
): number {
  let total = 0;
  for (const list of Object.values(modifiers)) {
    if (!Array.isArray(list)) continue;
    for (const mod of list) {
      if (mod.type === "bonus" && mod.subType === subType && mod.value != null) {
        total += mod.value;
      }
    }
  }
  return total;
}

export function computeFinalAbilityScore(
  base: DdbAbilityScore[],
  bonus: DdbAbilityScore[],
  override: DdbAbilityScore[],
  modifiers: Record<string, DdbModifier[]>,
  id: number
): number {
  const overrideValue = override.find((s) => s.id === id)?.value;
  if (overrideValue !== null && overrideValue !== undefined) return overrideValue;

  const baseValue = base.find((s) => s.id === id)?.value ?? 10;
  const bonusValue = bonus.find((s) => s.id === id)?.value ?? 0;
  const modifierBonus = sumModifierBonuses(modifiers, ABILITY_SUBTYPE_MAP[id] ?? "");
  return baseValue + bonusValue + modifierBonus;
}

export function computeLevel(char: DdbCharacter): number {
  return char.classes.reduce((sum, cls) => sum + cls.level, 0);
}

export function calculateMaxHp(char: DdbCharacter): number {
  const base = char.baseHitPoints;
  const bonus = char.bonusHitPoints ?? 0;
  const override = char.overrideHitPoints;
  return override ?? (base + bonus);
}

export function calculateCurrentHp(char: DdbCharacter): number {
  const max = calculateMaxHp(char);
  return max - char.removedHitPoints;
}

export function calculateAc(char: DdbCharacter): number {
  const dexMod = Math.floor((computeFinalAbilityScore(char.stats, char.bonusStats, char.overrideStats, char.modifiers, 2) - 10) / 2);
  const conMod = Math.floor((computeFinalAbilityScore(char.stats, char.bonusStats, char.overrideStats, char.modifiers, 3) - 10) / 2);
  const wisMod = Math.floor((computeFinalAbilityScore(char.stats, char.bonusStats, char.overrideStats, char.modifiers, 5) - 10) / 2);

  // Find equipped armor and shields
  let baseAc = 10;
  let armorType: "heavy" | "medium" | "light" | "none" = "none";
  let shieldBonus = 0;

  for (const item of char.inventory) {
    if (!item.equipped) continue;

    const def = item.definition;
    const itemType = def.type?.toLowerCase() || "";
    const filterType = def.filterType?.toLowerCase() || "";
    // D&D Beyond armorTypeId: 1 = light, 2 = medium, 3 = heavy, 4 = shield.
    // Some armor (e.g. Studded Leather) has an empty `type`, so prefer armorTypeId.
    const armorTypeId = def.armorTypeId ?? null;

    const isShield = armorTypeId === 4 || itemType.includes("shield");
    if (isShield) {
      shieldBonus = def.armorClass ?? 2;
      continue;
    }

    const isArmor =
      (armorTypeId !== null && armorTypeId >= 1 && armorTypeId <= 3) ||
      itemType.includes("armor") ||
      filterType === "armor";
    if (!isArmor) continue;

    baseAc = def.armorClass ?? 10;
    if (armorTypeId === 3 || itemType.includes("heavy")) {
      armorType = "heavy";
    } else if (armorTypeId === 2 || itemType.includes("medium")) {
      armorType = "medium";
    } else {
      armorType = "light";
    }
  }

  // Apply DEX modifier based on armor type
  let finalAc = baseAc;
  if (armorType === "none") {
    // Check for unarmored defense
    const isBarbarian = char.classes.some(cls => cls.definition.name === "Barbarian");
    const isMonk = char.classes.some(cls => cls.definition.name === "Monk");

    if (isBarbarian) {
      finalAc = 10 + dexMod + conMod;
    } else if (isMonk) {
      finalAc = 10 + dexMod + wisMod;
    } else {
      finalAc = 10 + dexMod;
    }
  } else if (armorType === "light") {
    finalAc = baseAc + dexMod;
  } else if (armorType === "medium") {
    finalAc = baseAc + Math.min(dexMod, 2);
  } else if (armorType === "heavy") {
    finalAc = baseAc; // No DEX bonus
  }

  // Add shield bonus
  finalAc += shieldBonus;

  // Add AC modifiers from features/spells
  const acBonus = sumModifierBonuses(char.modifiers, "armor-class")
    + (armorType !== "none" ? sumModifierBonuses(char.modifiers, "armored-armor-class") : 0)
    + (armorType === "none" ? sumModifierBonuses(char.modifiers, "unarmored-armor-class") : 0);

  finalAc += acBonus;

  return finalAc;
}

/**
 * Collect every spell on the character.
 *
 * D&D Beyond keeps a class's prepared/known spell list in `classSpells`, not in
 * `spells.class` (which only holds spells granted by class features). Spells from
 * race, background, items and feats are innate: they're usable without being
 * prepared, but D&D Beyond doesn't flag them as prepared. Cantrips are always
 * available too. Those get normalized to alwaysPrepared so prepared filters work.
 */
export function getAllSpells(char: DdbCharacter): DdbSpell[] {
  const innate = (spells: DdbSpell[] | null | undefined): DdbSpell[] =>
    (spells ?? []).map((sp) => ({ ...sp, alwaysPrepared: true }));
  const withCantrips = (spells: DdbSpell[] | null | undefined): DdbSpell[] =>
    (spells ?? []).map((sp) =>
      sp.definition?.level === 0 ? { ...sp, alwaysPrepared: true } : sp
    );

  const all: DdbSpell[] = [
    ...withCantrips(char.spells?.class),
    ...(char.classSpells ?? []).flatMap((cs) => withCantrips(cs.spells)),
    ...innate(char.spells?.race),
    ...innate(char.spells?.background),
    ...innate(char.spells?.item),
    ...innate(char.spells?.feat),
  ];

  // De-duplicate by spell name, keeping the most "available" copy.
  const byName = new Map<string, DdbSpell>();
  for (const sp of all) {
    const name = sp.definition?.name;
    if (!name) continue;
    const existing = byName.get(name);
    const rank = (x: DdbSpell) => (x.alwaysPrepared ? 2 : x.prepared ? 1 : 0);
    if (!existing || rank(sp) > rank(existing)) byName.set(name, sp);
  }
  // D&D Beyond can return both the 2014 and 2024 name of a spell (e.g.
  // "Melf's Acid Arrow" and "Acid Arrow"). Keep one, matching the edition the
  // character's own spells use (isLegacy), else the longer 2014-style name.
  const spells = [...byName.values()];
  const legacyVotes = spells.reduce((n, sp) => {
    const flag = (sp.definition as { isLegacy?: boolean }).isLegacy;
    return flag === true ? n + 1 : flag === false ? n - 1 : n;
  }, 0);
  const preferLegacy = legacyVotes >= 0;
  const drop = new Set<DdbSpell>();
  for (const a of spells) {
    for (const b of spells) {
      if (a === b || a.definition.level !== b.definition.level) continue;
      if (!a.definition.name.endsWith(" " + b.definition.name)) continue;
      // a = longer (2014-style) name, b = shorter (2024-style) name
      const aLegacy = (a.definition as { isLegacy?: boolean }).isLegacy;
      const bLegacy = (b.definition as { isLegacy?: boolean }).isLegacy;
      if (aLegacy === undefined && bLegacy === undefined) {
        drop.add(b);
      } else if (preferLegacy) {
        drop.add(bLegacy ? a : b);
      } else {
        drop.add(aLegacy ? a : b);
      }
    }
  }
  return spells.filter((sp) => !drop.has(sp));
}
