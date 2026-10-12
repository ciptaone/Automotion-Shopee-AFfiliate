/**
 * Mandatory editorial policy (Part 4).
 *
 * WHAT THIS ENFORCES (locked decisions):
 *  1. Every FINAL caption ends EXACTLY with `#ai #automation` — nothing after.
 *  2. No first-person ownership / receipt / usage / firsthand-result /
 *     personal-endorsement claims, unless genuinely true AND explicitly
 *     verified (which an automated pipeline can never assert — so: never).
 *  3. No fabricated prices, discounts, commission figures, or strong/medical
 *     benefit claims that the product record cannot support.
 *  4. The affiliate URL appears VERBATIM, and an affiliate disclosure is
 *     present in the body (not merely as a composite hashtag).
 *
 * HOW IT DETECTS CLAIMS (structured, not naive keyword matching):
 *  - The caption is NFKC-normalized, lower-cased, de-punctuated and split into
 *    CLAUSES (sentences / lines).
 *  - Each clause is tokenized. First-person presence is established by any of:
 *      * standalone subject tokens (aku, saya, gue, gw, daku, diriku),
 *      * fused clitics (kupakai -> ku+pakai, kusuka -> ku+suka, kubeli),
 *      * first-person possessives (punyaku, milikku, barangku, paketku).
 *  - A claim is only a violation when a first-person marker AND a category
 *    predicate co-occur in the SAME clause. A bare "coba deh" (imperative CTA)
 *    or "cocok buat kamu" (second-person product statement) is therefore NOT
 *    flagged, while "aku coba"/"di aku cocok"/"kupakai" are.
 *  - RECEIPT is additionally detected WITHOUT a subject, because phrases like
 *    "paketnya baru datang" / "barangnya udah nyampe" imply the account owner
 *    received the product even with no "aku".
 *
 * HONEST LIMITATIONS — read before trusting this:
 *  - These are HEURISTIC structured rules. They dramatically narrow the space
 *    of forbidden claims and are unit-tested against many variants, but they
 *    are NOT a substitute for human editorial review and they cannot prove a
 *    subtle implicit claim ("pas banget di meja kerja aku") in every phrasing.
 *  - A passing result means "no known violation pattern was found", NOT
 *    "a human verified this copy". No pipeline/report may present it as such.
 *  - Validation failures are surfaced explicitly and drive a BOUNDED
 *    regeneration in the pipeline; the gate is never bypassed to keep schedule.
 */
import { MANDATORY_FINAL_HASHTAGS } from '../contracts/index.js';
import type { ValidationIssue } from '../core/errors.js';

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

export type EditorialCategory =
  | 'structure'
  | 'ownership'
  | 'receipt'
  | 'usage'
  | 'firsthand_result'
  | 'endorsement'
  | 'unsupported_fact';

export interface EditorialCheck {
  readonly rule: string;
  readonly category: EditorialCategory;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  /** Normalized snippet that triggered the rule (redaction-safe, no secrets). */
  readonly evidence?: string;
}

/** Verified product facts the copy is allowed to reference. */
export interface VerifiedFacts {
  readonly price?: number | null;
  readonly currency?: string | null;
  readonly rating?: number | null;
  readonly soldCount?: number | null;
}

export interface EditorialContext {
  readonly requiredAffiliateUrl: string;
  readonly platform: 'facebook_page' | 'threads';
  readonly verifiedFacts?: VerifiedFacts;
}

export interface EditorialResult {
  /** True when no error-severity check failed. */
  readonly passed: boolean;
  readonly checks: readonly EditorialCheck[];
  /** Normalized text the clause engine ran on (for transparency/tests). */
  readonly normalizedText: string;
  readonly mandatoryFinalHashtagsPresent: boolean;
  readonly disclosurePresent: boolean;
}

export const EDITORIAL_LIMITATIONS =
  'Heuristic structured claim detection + structural rules. Not a substitute for human editorial review; ' +
  'a passing result means no known violation pattern matched, not that a human verified the copy.';

export const MANDATORY_ENDING = MANDATORY_FINAL_HASHTAGS;

/* -------------------------------------------------------------------------- */
/*  Normalization                                                             */
/* -------------------------------------------------------------------------- */

/** NFKC + case-fold + punctuation/whitespace normalization for claim parsing. */
export function normalizeForClaims(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/*  Claim vocabulary                                                          */
/* -------------------------------------------------------------------------- */

const PERSONAL_SUBJECTS = new Set([
  'aku',
  'saya',
  'sya',
  'gue',
  'gua',
  'gw',
  'daku',
  'diriku',
  'akusendiri',
]);

const OWNERSHIP_VERBS = new Set([
  'punya',
  'memiliki',
  'mempunyai',
  'membeli',
  'beli',
  'borong',
  'checkout',
  'memesan',
  'pesan',
  'order',
  'orderkan',
]);

const RECEIPT_VERBS = new Set([
  'menerima',
  'nerima',
  'mendapat',
  'mendapatkan',
  'dapet',
  'dapat',
]);

const USAGE_VERBS = new Set([
  'pakai',
  'pake',
  'memakai',
  'menggunakan',
  'gunakan',
  'coba',
  'cobain',
  'nyoba',
  'mencoba',
  'mencobai',
  'kenakan',
  'apply',
  'tes',
  'test',
]);

const RESULT_VERBS = new Set(['mempan', 'ngefek', 'berhasil', 'cocok', 'manjur', 'ampuh']);

const ENDORSEMENT_VERBS = new Set([
  'tertarik',
  'suka',
  'doyan',
  'favorit',
  'favorite',
  'recommend',
  'rekomendasiin',
  'rekomendasi',
  'merekomendasikan',
  'menyarankan',
]);

/** Any predicate verb — used to disambiguate fused `ku`-clitics. */
const VERB_UNIVERSE = new Set([
  ...OWNERSHIP_VERBS,
  ...RECEIPT_VERBS,
  ...USAGE_VERBS,
  ...RESULT_VERBS,
  ...ENDORSEMENT_VERBS,
]);

/** Nouns whose `-ku` suffix is a genuine first-person possessive. */
const POSSESSIVE_NOUNS = new Set([
  'punya',
  'milik',
  'barang',
  'paket',
  'produk',
  'pesanan',
  'belanjaan',
  'stok',
  'unit',
  'koleksi',
  'langganan',
]);

/** Subject-less phrases that still imply the owner received/used the item. */
const RECEIPT_PHRASES: readonly RegExp[] = [
  /\b(?:barang|paket|pesanan|orderan|belanjaan|unit)\w*\s+(?:baru\s+)?(?:datang|sampai|nyampe|sampe|tiba|diterima|dikirim)\b/,
  /\b(?:udah|sudah|barusan|baru)\s+(?:nyampe|sampe|sampai|datang|diterima)\b/,
  /\b(?:unboxing|buka paket|buka paketnya)\b/,
  /(?:baru|udah|sudah|barusan)\s+membuka\s+paket\b/,
];

/** Phrasal first-person OPINION markers (an unverifiable personal stance). */
const OPINION_MARKERS: readonly RegExp[] = [
  /\bmenurut\s+(?:aku|saya|gue|gw|daku)\b/,
  /\bdi\s+(?:aku|saya|gue|gw|daku)\b/,
  /\bbuat\s+(?:aku|saya|gue|gw|daku)\b/,
  /\bke\s+(?:aku|saya|gue|gw|daku)\b/,
];

/** First-person markers that are phrasal rather than single tokens. */
const FIRST_PERSON_PHRASES: readonly RegExp[] = [
  ...OPINION_MARKERS,
  /\b(?:aku|saya|gue|gw|daku)\s+banget\b/,
];

/* -------------------------------------------------------------------------- */
/*  Fabrication guards                                                        */
/* -------------------------------------------------------------------------- */

const BENEFIT_FABRICATION: readonly RegExp[] = [
  /\b(?:menyembuhkan|mengobati|menyembuh)\b/,
  /\bmenjamin\b/,
  /\bdijamin\b/,
  /\bpasti\s+(?:berhasil|aman|puas|cocok|awet)\b/,
  /100\s?%\s*(?:aman|ampuh|manjur|original|berhasil|puas)\b/,
  /\bterbukti\s+(?:klinis|aman|ampuh|manjur)\b/,
  /\btanpa\s+efek\s+samping\b/,
  /\bmelangsingkan\b/,
  /\bmenurunkan\s+berat\s+badan\b/,
  /\bmenambah\s+tinggi\b/,
  /\bmeningkatkan\s+(?:vitalitas|kesuburan|kekebalan|libido|metabolisme)\b/,
];

const DISCOUNT_FABRICATION: readonly RegExp[] = [
  /\b(?:diskon|promo|sale|potongan|cuci\s+gudang|flash\s+sale)\b/,
  /\b(?:gratis\s+ongkir|free\s+shipping|cashback|beli\s+\d+\s+gratis\s+\d+)\b/,
  /\b\d{1,2}\s?%\s*(?:off|diskon|potongan|discount)\b/,
];

const COMMISSION_FABRICATION: readonly RegExp[] = [
  /\b(?:komisi|commission)\b/,
  /\bkomisi\s+(?:sampai|hingga|max|tertinggi)\b/,
];

const DISCOUNT_OR_PROMO = DISCOUNT_FABRICATION;
const COMMISSION = COMMISSION_FABRICATION;

/* -------------------------------------------------------------------------- */
/*  Clause + token engine                                                     */
/* -------------------------------------------------------------------------- */

interface Clause {
  readonly text: string;
  readonly tokens: ReadonlySet<string>;
  readonly hasFirstPerson: boolean;
  /** First-person possessive found in the clause (punyaku/milikku/barangku). */
  readonly possessive: string | null;
  /** Phrasal opinion marker found (menurut aku / di aku / buat aku / …). */
  readonly hasOpinionMarker: boolean;
}

function splitKuClitic(word: string): { subject: string; rest: string } | null {
  if (word.startsWith('ku') && word.length >= 5) {
    const rest = word.slice(2);
    if (VERB_UNIVERSE.has(rest)) {
      return { subject: 'ku', rest };
    }
  }
  return null;
}

function isPossessive(word: string): boolean {
  if (!word.endsWith('ku') || word.length < 5) return false;
  const stem = word.slice(0, -2);
  return POSSESSIVE_NOUNS.has(stem);
}

function tokenizeClause(raw: string): Clause {
  const words = normalizeForClaims(raw)
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);

  const tokens = new Set<string>();
  let hasFirstPerson = false;
  let possessive: string | null = null;

  for (const word of words) {
    tokens.add(word);
    if (PERSONAL_SUBJECTS.has(word)) hasFirstPerson = true;
    if (isPossessive(word)) {
      hasFirstPerson = true;
      possessive ??= word;
    }
    const clitic = splitKuClitic(word);
    if (clitic) {
      tokens.add(clitic.rest);
      hasFirstPerson = true;
    }
  }

  // Phrasal first-person markers over the whole clause.
  const normalized = normalizeForClaims(raw);
  for (const pattern of FIRST_PERSON_PHRASES) {
    if (pattern.test(normalized)) {
      hasFirstPerson = true;
      break;
    }
  }
  const hasOpinionMarker = OPINION_MARKERS.some((pattern) => pattern.test(normalized));

  return { text: normalized, tokens, hasFirstPerson, possessive, hasOpinionMarker };
}

function splitClauses(text: string): string[] {
  return text
    .split(/[.!?\n\r;]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function firstMatching(
  clause: Clause,
  vocabulary: ReadonlySet<string>,
): string | null {
  for (const token of clause.tokens) {
    if (vocabulary.has(token)) return token;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Price parsing (Indonesian separators)                                     */
/* -------------------------------------------------------------------------- */

function parseIdNumber(raw: string): number {
  const cleaned = raw.replace(/\./g, '').replace(/,/g, '.');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : Number.NaN;
}

function extractPriceMentions(text: string): number[] {
  const results: number[] = [];
  const regex = /(?:rp\.?\s*|idr\s*)([\d][\d.,]*)|\bharga\s+(?:rp\.?\s*)?([\d][\d.,]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    const parsed = parseIdNumber(raw);
    if (Number.isFinite(parsed)) results.push(parsed);
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/*  Disclosure + ending                                                       */
/* -------------------------------------------------------------------------- */

function stripHashtags(text: string): string {
  return text.replace(/#[\p{L}\p{N}_]+/gu, ' ');
}

/**
 * Disclosure must appear as PROSE (`link afiliasi`, `afiliasi`, `iklan`), not
 * merely as a composite hashtag like `#ShopeeAffiliate`.
 */
function hasDisclosure(text: string): boolean {
  const prose = stripHashtags(text);
  return /\bafiliasi\b|\biklan\b|\bberbayar\b|\bbersponsor\b/i.test(prose);
}

function endsWithMandatory(text: string): boolean {
  const trimmed = text.replace(/\s+$/, '');
  return /#ai\s+#automation$/i.test(trimmed);
}

/* -------------------------------------------------------------------------- */
/*  Main evaluator                                                            */
/* -------------------------------------------------------------------------- */

export function evaluateEditorialPolicy(
  caption: string,
  context: EditorialContext,
): EditorialResult {
  const checks: EditorialCheck[] = [];
  const normalizedText = normalizeForClaims(caption);

  /* --- Structure: mandatory final hashtags, nothing after --- */
  const mandatoryFinalHashtagsPresent = endsWithMandatory(caption);
  if (!mandatoryFinalHashtagsPresent) {
    const hasItSomewhere = /#ai\b/i.test(caption) && /#automation\b/i.test(caption);
    checks.push({
      rule: 'editorial.mandatory_final_hashtags',
      category: 'structure',
      severity: 'error',
      message: hasItSomewhere
        ? `Caption must END exactly with "${MANDATORY_ENDING}" — no text or hashtags may appear after it.`
        : `Caption must end exactly with "${MANDATORY_ENDING}".`,
    });
  }

  /* --- Structure: affiliate URL verbatim --- */
  const url = context.requiredAffiliateUrl;
  if (!url || url.trim().length === 0) {
    checks.push({
      rule: 'editorial.affiliate_url_provided',
      category: 'structure',
      severity: 'error',
      message: 'No affiliate URL was supplied to validate the caption against.',
    });
  } else if (!caption.includes(url)) {
    checks.push({
      rule: 'editorial.affiliate_url_verbatim',
      category: 'structure',
      severity: 'error',
      message: 'Affiliate URL does not appear verbatim in the caption.',
    });
  }

  /* --- Structure: disclosure --- */
  const disclosurePresent = hasDisclosure(caption);
  if (!disclosurePresent) {
    checks.push({
      rule: 'editorial.affiliate_disclosure',
      category: 'structure',
      severity: 'error',
      message:
        'Caption is missing an affiliate disclosure in the body (e.g. "link afiliasi"); a composite hashtag does not count.',
    });
  }

  /* --- Claim detection over clauses --- */
  const clauses = splitClauses(caption).map(tokenizeClause);
  const claimedCategories = new Set<EditorialCategory>();

  for (const clause of clauses) {
    // RECEIPT: works with OR without a first-person subject.
    for (const pattern of RECEIPT_PHRASES) {
      if (pattern.test(clause.text) && !claimedCategories.has('receipt')) {
        claimedCategories.add('receipt');
        checks.push({
          rule: 'editorial.no_first_person_claim',
          category: 'receipt',
          severity: 'error',
          message:
            'Caption implies the account owner RECEIVED the product; automated content may never claim receipt.',
          evidence: clause.text.slice(0, 80),
        });
      }
    }

    if (!clause.hasFirstPerson) continue;

    // Possessive alone ("Barang ini punyaku") IS an ownership claim — no verb
    // needed. This is the indirect variant the brief calls out.
    if (clause.possessive && !claimedCategories.has('ownership')) {
      claimedCategories.add('ownership');
      checks.push({
        rule: 'editorial.no_first_person_claim',
        category: 'ownership',
        severity: 'error',
        message: `Caption uses a first-person possessive ("${clause.possessive}"), implying the account owner owns the product.`,
        evidence: clause.text.slice(0, 80),
      });
    }

    const ownership = firstMatching(clause, OWNERSHIP_VERBS);
    if (ownership && !claimedCategories.has('ownership')) {
      claimedCategories.add('ownership');
      checks.push({
        rule: 'editorial.no_first_person_claim',
        category: 'ownership',
        severity: 'error',
        message: 'Caption contains a first-person OWNERSHIP claim ("punya/beli/..."), which is unverifiable.',
        evidence: clause.text.slice(0, 80),
      });
    }

    const receipt = firstMatching(clause, RECEIPT_VERBS);
    if (receipt && !claimedCategories.has('receipt')) {
      claimedCategories.add('receipt');
      checks.push({
        rule: 'editorial.no_first_person_claim',
        category: 'receipt',
        severity: 'error',
        message: 'Caption contains a first-person RECEIPT claim ("menerima/dapet/..."), which is unverifiable.',
        evidence: clause.text.slice(0, 80),
      });
    }

    const usage = firstMatching(clause, USAGE_VERBS);
    if (usage && !claimedCategories.has('usage')) {
      claimedCategories.add('usage');
      checks.push({
        rule: 'editorial.no_first_person_claim',
        category: 'usage',
        severity: 'error',
        message: 'Caption contains a first-person USAGE claim ("pakai/coba/..."), which is unverifiable.',
        evidence: clause.text.slice(0, 80),
      });
    }

    const result = firstMatching(clause, RESULT_VERBS);
    if (result && !claimedCategories.has('firsthand_result')) {
      claimedCategories.add('firsthand_result');
      checks.push({
        rule: 'editorial.no_first_person_claim',
        category: 'firsthand_result',
        severity: 'error',
        message:
          'Caption asserts a firsthand RESULT ("cocok/mempan/...") tied to the account owner, which is unverifiable.',
        evidence: clause.text.slice(0, 80),
      });
    }

    const endorsement = firstMatching(clause, ENDORSEMENT_VERBS);
    if (endorsement && !claimedCategories.has('endorsement')) {
      claimedCategories.add('endorsement');
      checks.push({
        rule: 'editorial.no_first_person_claim',
        category: 'endorsement',
        severity: 'error',
        message:
          'Caption contains a personal ENDORSEMENT/interest claim ("tertarik/suka/rekomendasiin/..."), which is unverifiable.',
        evidence: clause.text.slice(0, 80),
      });
    }

    // Phrasal opinion marker ("menurut aku, ini bagus") is an unverifiable
    // personal stance even with no explicit endorsement verb.
    if (clause.hasOpinionMarker && !claimedCategories.has('endorsement')) {
      claimedCategories.add('endorsement');
      checks.push({
        rule: 'editorial.no_first_person_claim',
        category: 'endorsement',
        severity: 'error',
        message:
          'Caption frames the copy as the account owner\'s personal opinion ("menurut aku/di aku/buat aku"), which is unverifiable.',
        evidence: clause.text.slice(0, 80),
      });
    }
  }

  /* --- Unsupported factual claims --- */
  // Fabrication guards scan the caption MINUS the machine-provided affiliate
  // URL (a shortlink containing e.g. "promo" must never block real copy).
  const urlForScan = url ? normalizeForClaims(url) : '';
  const fabricationScanText = urlForScan
    ? normalizedText.replace(urlForScan, ' ')
    : normalizedText;

  for (const pattern of BENEFIT_FABRICATION) {
    const match = pattern.exec(fabricationScanText);
    if (match) {
      checks.push({
        rule: 'editorial.no_unsupported_benefit',
        category: 'unsupported_fact',
        severity: 'error',
        message: `Caption states an unsupported/strong benefit claim ("${match[0].slice(0, 40)}") not grounded in product data.`,
        evidence: match[0].slice(0, 80),
      });
      break;
    }
  }

  for (const pattern of DISCOUNT_OR_PROMO) {
    const match = pattern.exec(fabricationScanText);
    if (match) {
      checks.push({
        rule: 'editorial.no_unsupported_discount',
        category: 'unsupported_fact',
        severity: 'error',
        message: `Caption states an unverifiable promotion/discount ("${match[0].slice(0, 40)}").`,
        evidence: match[0].slice(0, 80),
      });
      break;
    }
  }

  for (const pattern of COMMISSION) {
    const match = pattern.exec(fabricationScanText);
    if (match) {
      checks.push({
        rule: 'editorial.no_unsupported_commission',
        category: 'unsupported_fact',
        severity: 'error',
        message: `Caption states a commission figure ("${match[0].slice(0, 40)}") that cannot be verified.`,
        evidence: match[0].slice(0, 80),
      });
      break;
    }
  }

  /* --- Unsupported price --- */
  const priceMentions = extractPriceMentions(caption);
  if (priceMentions.length > 0) {
    const verified = context.verifiedFacts?.price ?? null;
    if (verified === null) {
      checks.push({
        rule: 'editorial.no_unsupported_price',
        category: 'unsupported_fact',
        severity: 'error',
        message: 'Caption states a price but the product record carries no verified price.',
        evidence: String(priceMentions[0] ?? ''),
      });
    } else {
      const mismatched = priceMentions.find((p) => Math.round(p) !== Math.round(verified));
      if (mismatched !== undefined) {
        checks.push({
          rule: 'editorial.no_unsupported_price',
          category: 'unsupported_fact',
          severity: 'error',
          message: `Caption states a price that differs from the verified catalog price (${verified}).`,
          evidence: mismatched.toString(),
        });
      }
    }
  }

  const passed = checks.every((c) => c.severity !== 'error');

  return {
    passed,
    checks,
    normalizedText,
    mandatoryFinalHashtagsPresent,
    disclosurePresent,
  };
}

/** Flatten an editorial result into the publish-gate ValidationIssue shape. */
export function editorialToValidationIssues(result: EditorialResult): ValidationIssue[] {
  return result.checks.map((check) => ({
    rule: check.rule,
    message: check.category === 'structure' ? check.message : `[${check.category}] ${check.message}`,
    severity: check.severity,
  }));
}

/** Convenience: evaluate and return publish-gate issues in one call. */
export function validateEditorial(
  caption: string,
  context: EditorialContext,
): ValidationIssue[] {
  return editorialToValidationIssues(evaluateEditorialPolicy(caption, context));
}
