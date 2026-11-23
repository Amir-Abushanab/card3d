/**
 * What makes a card look like a payment card, found in a design's text: card-number-like digit runs
 * (Luhn checked), expiry and security-code labels, payment network names. Pure; used by preflight in
 * both modes (a non-payment card must not carry them; a payment card's art shouldn't either, since the
 * issuer personalises the number, name and dates).
 *
 * Any run of 13–19 digits counts, grouped
 * (4-4-4-4, 4-6-5) or not, Luhn-valid or not; IDs of 10 digits or fewer, or with letters, don't.
 */
import type { CardDesign } from "@card3d/core/model";

/** Luhn (mod 10) check of a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export interface PanMatch {
  /** The run as written. */
  text: string;
  digits: string;
  length: number;
  luhn: boolean;
  /** A 15, 16 or 19-digit run passing Luhn: the shape of a real card number. */
  cardNumber: boolean;
}

/** Digit runs of 13–19 digits (single spaces, dashes or dots between groups allowed). */
export function findPanLike(text: string): PanMatch[] {
  const out: PanMatch[] = [];
  // Digits with optional single separators, not touching other digits.
  const re = /(?<![\d])\d(?:[ \-. ]?\d){12,22}(?![\d])/g;
  for (const m of text.matchAll(re)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    const luhn = luhnValid(digits);
    out.push({ text: m[0], digits, length: digits.length, luhn, cardNumber: luhn && [15, 16, 19].includes(digits.length) });
  }
  return out;
}

/** "VALID THRU", "GOOD THRU", "VALID FROM", "EXP", "EXPIRES", "EXPIRY". */
const EXPIRY_LABEL = /\b(valid\s*(thru|through|to|from|until)|good\s*thru|exp(\.|ires|iry|iration)?|month\s*\/\s*year)\b/i;
/** "CVV", "CVC", "CVV2", "CVC2", "CID", "CSC", "SECURITY CODE". */
const SECURITY_LABEL = /\b(cvv2?|cvc2?|cid|csc|security\s*code)\b/i;
/** An MM/YY or MM/YYYY date. */
const EXPIRY_DATE = /(?<!\d)(0[1-9]|1[0-2])\s*[/-]\s*(\d{2}|20\d{2})(?!\d)/;

/**
 * Payment network and scheme names. `strict`: unambiguous brand names; the others are ordinary words
 * too (a warning, not a block).
 */
const NETWORKS: Array<{ re: RegExp; name: string; strict: boolean }> = [
  { re: /\bvisa\b/i, name: "Visa", strict: true },
  { re: /\bmaster\s?card\b/i, name: "Mastercard", strict: true },
  { re: /\bmaestro\b/i, name: "Maestro", strict: true },
  { re: /\bamex\b|\bamerican\s+express\b/i, name: "American Express", strict: true },
  { re: /\bdiners\s+club\b/i, name: "Diners Club", strict: true },
  { re: /\bjcb\b/i, name: "JCB", strict: true },
  { re: /\bunion\s?pay\b/i, name: "UnionPay", strict: true },
  { re: /\binterac\b/i, name: "Interac", strict: true },
  { re: /\brupay\b/i, name: "RuPay", strict: true },
  { re: /\bcirrus\b/i, name: "Cirrus", strict: true },
  { re: /\bv\s?pay\b/i, name: "V Pay", strict: true },
  { re: /\bdiscover\b/i, name: "Discover", strict: false },
  { re: /\bcenturion\b/i, name: "Centurion", strict: false },
];

export function findNetworks(text: string): Array<{ name: string; strict: boolean }> {
  return NETWORKS.filter((n) => n.re.test(text)).map(({ name, strict }) => ({ name, strict }));
}

/** Every piece of text a design prints, with where it comes from. */
interface DesignText {
  /** "name", "bio", "line1"… */
  key: string;
  label: string;
  text: string;
}

function designTexts(d: Pick<CardDesign, "cardholderName" | "cardholderBio" | "textLines">): DesignText[] {
  const out: DesignText[] = [];
  if (d.cardholderName?.trim()) out.push({ key: "name", label: "Cardholder name", text: d.cardholderName });
  if (d.cardholderBio?.trim()) out.push({ key: "bio", label: "Bio", text: d.cardholderBio });
  (d.textLines ?? []).forEach((l, i) => {
    if (l?.text?.trim()) out.push({ key: `line${i + 1}`, label: `Text line ${i + 1}`, text: l.text });
  });
  return out;
}

export interface TextFinding {
  key: string;
  label: string;
  text: string;
  pan: PanMatch[];
  expiryLabel: boolean;
  expiryDate: boolean;
  securityLabel: boolean;
  networks: Array<{ name: string; strict: boolean }>;
}

/** What each text of the design carries. */
export function scanTexts(d: Pick<CardDesign, "cardholderName" | "cardholderBio" | "textLines">): TextFinding[] {
  return designTexts(d).map((t) => ({
    ...t,
    pan: findPanLike(t.text),
    expiryLabel: EXPIRY_LABEL.test(t.text),
    expiryDate: EXPIRY_DATE.test(t.text),
    securityLabel: SECURITY_LABEL.test(t.text),
    networks: findNetworks(t.text),
  }));
}

export interface LookalikeFeatures {
  /** A contact chip plate that isn't declared a decorative / NFC module (0.5 when declared). */
  chip: number;
  magstripe: boolean;
  number: boolean;
  expiry: boolean;
  networkMark: boolean;
  securityPanel: boolean;
  contactless: boolean;
}

/**
 * The "payment look-alike score": chip, magnetic stripe, card number, expiry,
 * a network-style mark, a signature / CVV panel and the contactless indicator, each 0–1, weighted
 * (number and network mark count double), as a share of the total. A chip together with two or more
 * of number, expiry, network mark or stripe is a look-alike whatever the score.
 */
export function lookalikeScore(f: LookalikeFeatures): { score: number; lookalike: boolean } {
  const w = { chip: 1, magstripe: 1, number: 2, expiry: 1, networkMark: 2, securityPanel: 1, contactless: 1 };
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const s =
    w.chip * f.chip +
    w.magstripe * +f.magstripe +
    w.number * +f.number +
    w.expiry * +f.expiry +
    w.networkMark * +f.networkMark +
    w.securityPanel * +f.securityPanel +
    w.contactless * +f.contactless;
  const score = Math.round((s / total) * 100) / 100;
  const pairs = [f.number, f.expiry, f.networkMark, f.magstripe].filter(Boolean).length;
  return { score, lookalike: score >= 0.45 || (f.chip >= 1 && pairs >= 2) };
}
