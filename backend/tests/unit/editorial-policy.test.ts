/**
 * PART 4 — mandatory editorial policy.
 *
 * Covers: false first-person claims (ownership / receipt / usage / firsthand
 * result / endorsement) plus indirect variants (possessives, fused ku-clitics,
 * subject-less receipt phrases, phrasal opinion markers); valid neutral product
 * copy that must PASS; unsupported benefit/discount/commission/price claims;
 * verbatim affiliate-URL preservation; the mandatory `#ai #automation` ending
 * with no trailing text; affiliate disclosure; and normalization (case,
 * punctuation, whitespace, Unicode).
 *
 * Credential-free and deterministic: pure functions only. IMPORTANT: a passing
 * result means "no known violation pattern matched" — never "a human verified
 * this copy"; the limitations string is asserted to say exactly that.
 */
import { describe, it, expect } from 'vitest';
import {
  EDITORIAL_LIMITATIONS,
  MANDATORY_ENDING,
  evaluateEditorialPolicy,
  editorialToValidationIssues,
  normalizeForClaims,
  validateEditorial,
  type EditorialCategory,
  type EditorialContext,
} from '../../src/pipeline/editorial-policy.js';
import { MANDATORY_FINAL_HASHTAGS } from '../../src/contracts/index.js';

const AFFILIATE_URL = 'https://s.shopee.co.id/aff-1';

/** Full caption: body + disclosure + hashtags + URL + mandatory ending. */
function cap(body: string): string {
  return [
    body,
    'Link di bawah adalah link afiliasi.',
    '#Shopee #Tumbler',
    AFFILIATE_URL,
    MANDATORY_FINAL_HASHTAGS,
  ].join('\n\n');
}

function ctx(overrides: Partial<EditorialContext> = {}): EditorialContext {
  return {
    requiredAffiliateUrl: AFFILIATE_URL,
    platform: 'facebook_page',
    verifiedFacts: { price: 150000, currency: 'Rp', rating: 4.8, soldCount: 500 },
    ...overrides,
  };
}

function categoriesOf(body: string, overrides: Partial<EditorialContext> = {}): EditorialCategory[] {
  const result = evaluateEditorialPolicy(cap(body), ctx(overrides));
  return result.checks.map((c) => c.category);
}

describe('editorial policy — contract constants', () => {
  it('locks the mandatory ending to exactly "#ai #automation"', () => {
    expect(MANDATORY_ENDING).toBe('#ai #automation');
    expect(MANDATORY_FINAL_HASHTAGS).toBe('#ai #automation');
  });

  it('publishes honest limitations (never claims human-level review)', () => {
    expect(EDITORIAL_LIMITATIONS).toMatch(/not a substitute for human/i);
    expect(EDITORIAL_LIMITATIONS).toMatch(/no known violation pattern/i);
  });
});

describe('editorial policy — FALSE first-person claims are rejected', () => {
  it('rejects ownership claims ("Aku punya / memiliki / beli")', () => {
    expect(categoriesOf('Aku punya produk ini.')).toContain('ownership');
    expect(categoriesOf('Aku memiliki produk ini sekarang.')).toContain('ownership');
    expect(categoriesOf('Aku beli produk ini kemarin.')).toContain('ownership');
  });

  it('rejects usage claims ("Aku pakai / memakai / sudah mencoba")', () => {
    expect(categoriesOf('Aku pakai produk ini tiap hari.')).toContain('usage');
    expect(categoriesOf('Aku memakai produk ini.')).toContain('usage');
    expect(categoriesOf('Aku sudah mencoba produk ini.')).toContain('usage');
    expect(categoriesOf('Aku coba langsung deh.')).toContain('usage');
  });

  it('rejects receipt claims ("Aku baru menerima")', () => {
    expect(categoriesOf('Aku baru menerima paketnya.')).toContain('receipt');
    expect(categoriesOf('Aku dapet kiriman ini tadi.')).toContain('receipt');
  });

  it('rejects interest/endorsement claims ("Aku tertarik")', () => {
    expect(categoriesOf('Aku tertarik banget sama produk ini.')).toContain('endorsement');
    expect(categoriesOf('Aku suka banget desainnya.')).toContain('endorsement');
  });

  it('rejects firsthand-result claims ("Di aku cocok")', () => {
    const cats = categoriesOf('Di aku cocok banget produk ini.');
    expect(cats).toContain('endorsement');
    expect(cats).toContain('firsthand_result');
  });

  it('rejects INDIRECT variants: first-person possessives', () => {
    expect(categoriesOf('Ini punyaku sejak lama.')).toContain('ownership');
    expect(categoriesOf('Barangku selalu rapi.')).toContain('ownership');
    expect(categoriesOf('Milikku sudah lama awet.')).toContain('ownership');
  });

  it('rejects INDIRECT variants: fused ku-clitics', () => {
    expect(categoriesOf('Kupakai langsung pagi ini.')).toContain('usage');
    expect(categoriesOf('Kubeli dari Shopee.')).toContain('ownership');
    expect(categoriesOf('Kusuka banget warnanya.')).toContain('endorsement');
  });

  it('rejects INDIRECT variants: subject-less receipt phrases', () => {
    expect(categoriesOf('Barangnya baru datang tadi pagi.')).toContain('receipt');
    expect(categoriesOf('Paketnya udah nyampe kemarin.')).toContain('receipt');
    expect(categoriesOf('Barang ini sudah sampai di rumah.')).toContain('receipt');
    expect(categoriesOf('Aku baru unboxing isinya.')).toContain('receipt');
  });

  it('rejects INDIRECT variants: phrasal opinion markers', () => {
    expect(categoriesOf('Menurut aku, kualitasnya oke.')).toContain('endorsement');
    expect(categoriesOf('Buat aku produk ini biasa saja.')).toContain('endorsement');
    expect(categoriesOf('Ke aku rasanya pas.')).toContain('endorsement');
  });

  it('applies the same rules on the Threads platform', () => {
    const result = evaluateEditorialPolicy(cap('Aku pakai produk ini tiap hari.'), {
      requiredAffiliateUrl: AFFILIATE_URL,
      platform: 'threads',
    });
    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.category === 'usage')).toBe(true);
  });
});

describe('editorial policy — VALID neutral copy passes', () => {
  const neutral =
    'Produknya: Tumbler Stainless 500ml. Kategori Health & Beauty. Harga Rp 150.000. ' +
    'Rating 4.8 dari pembeli. Sudah terjual 500+. ' +
    'Cek sendiri detail dan ketersediaannya lewat link di bawah ya. ' +
    'Klik linknya, cek langsung di Shopee.';

  it('passes a neutral, product-focused Indonesian caption', () => {
    const result = evaluateEditorialPolicy(cap(neutral), ctx());
    expect(result.checks).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.mandatoryFinalHashtagsPresent).toBe(true);
    expect(result.disclosurePresent).toBe(true);
  });

  it('does NOT flag imperative CTAs (no first-person subject)', () => {
    expect(categoriesOf('Coba deh sekarang, cek langsung di Shopee!')).toEqual([]);
    expect(categoriesOf('Cocok buat kamu yang suka hal simpel.')).toEqual([]);
    expect(categoriesOf('Rekomendasi buat yang cari yang praktis.')).toEqual([]);
  });

  it('does NOT flag third-person product statements containing claim verbs', () => {
    // "punya"/"suka" are claim vocabulary, but with no first-person marker in
    // the clause they are ordinary product descriptions.
    expect(categoriesOf('Produk ini punya desain simpel.')).toEqual([]);
    expect(categoriesOf('Produk ini disukai banyak orang.')).toEqual([]);
  });

  it('reports zero checks for the exact structure the mock generator emits', () => {
    const mockStyle = [
      'Lagi cari yang praktis dan tetap kece?',
      'Produknya: Synthetic Product 1. Kategori Health & Beauty. Harga Rp 150.000. Rating 4.8 dari pembeli.',
      'Cek sendiri detail dan ketersediaannya lewat link di bawah ya.',
      'Klik linknya, cek langsung di Shopee. 👉',
      'Link di bawah adalah link afiliasi.',
      '#Shopee #ShopeeAffiliate #Health',
      AFFILIATE_URL,
      '#ai #automation',
    ].join('\n\n');
    const result = evaluateEditorialPolicy(mockStyle, ctx());
    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([]);
  });
});

describe('editorial policy — unsupported factual claims are rejected', () => {
  it('rejects strong/medical benefit claims', () => {
    expect(categoriesOf('Obat ini bisa menyembuhkan segala penyakit.')).toContain(
      'unsupported_fact',
    );
    expect(categoriesOf('Dijamin 100% ampuh dalam seminggu.')).toContain('unsupported_fact');
    expect(categoriesOf('Pasti berhasil dalam sehari.')).toContain('unsupported_fact');
    expect(categoriesOf('Pakai ini tanpa efek samping.')).toContain('unsupported_fact');
  });

  it('rejects unverifiable promotions/discounts', () => {
    expect(categoriesOf('Ada diskon 50% hari ini.')).toContain('unsupported_fact');
    expect(categoriesOf('Promo besar-besaran sekarang.')).toContain('unsupported_fact');
    expect(categoriesOf('Gratis ongkir kemana-mana.')).toContain('unsupported_fact');
  });

  it('rejects commission figures', () => {
    expect(categoriesOf('Komisi 12% menanti kamu.')).toContain('unsupported_fact');
  });

  it('rejects a price that differs from the verified catalog price', () => {
    const result = evaluateEditorialPolicy(cap('Harga Rp 99.000 only.'), ctx());
    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.rule === 'editorial.no_unsupported_price')).toBe(true);
  });

  it('rejects ANY price when the product record has no verified price', () => {
    const result = evaluateEditorialPolicy(cap('Harga Rp 150.000 only.'), {
      ...ctx(),
      verifiedFacts: { price: null },
    });
    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.rule === 'editorial.no_unsupported_price')).toBe(true);
  });

  it('accepts a price that matches the verified catalog price', () => {
    const result = evaluateEditorialPolicy(cap('Harga Rp 150.000.'), ctx());
    expect(result.checks.some((c) => c.rule === 'editorial.no_unsupported_price')).toBe(false);
  });

  it('never treats the machine-provided affiliate URL as a fabrication', () => {
    // A shortlink that happens to contain a fabrication keyword must not block.
    const url = 'https://s.shopee.co.id/promo-aff-1';
    const text = [
      'Produknya: Tumbler Stainless.',
      'Link afiliasi:',
      url,
      '#ai #automation',
    ].join('\n\n');
    const result = evaluateEditorialPolicy(text, {
      requiredAffiliateUrl: url,
      platform: 'facebook_page',
      verifiedFacts: { price: null },
    });
    expect(result.checks.some((c) => c.rule === 'editorial.no_unsupported_discount')).toBe(false);
  });
});

describe('editorial policy — affiliate URL preserved verbatim', () => {
  it('rejects an altered URL (case change)', () => {
    const result = evaluateEditorialPolicy(
      cap('Produk keren.').replace(AFFILIATE_URL, 'https://s.shopee.co.id/AFF-1'),
      ctx(),
    );
    expect(result.checks.some((c) => c.rule === 'editorial.affiliate_url_verbatim')).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('rejects a caption with no URL at all', () => {
    const text = ['Produk keren.', 'Link afiliasi di atas ya.', '#ai #automation'].join('\n\n');
    const result = evaluateEditorialPolicy(text, ctx());
    expect(result.checks.some((c) => c.rule === 'editorial.affiliate_url_verbatim')).toBe(true);
  });

  it('rejects a missing required URL outright (context error)', () => {
    const result = evaluateEditorialPolicy('Teks.', { ...ctx(), requiredAffiliateUrl: '' });
    expect(result.checks.some((c) => c.rule === 'editorial.affiliate_url_provided')).toBe(true);
  });

  it('accepts the exact URL', () => {
    const result = evaluateEditorialPolicy(cap('Produk keren.'), ctx());
    expect(result.checks.some((c) => c.rule === 'editorial.affiliate_url_verbatim')).toBe(false);
  });
});

describe('editorial policy — mandatory final hashtags', () => {
  it('passes when the caption ends exactly with "#ai #automation"', () => {
    const result = evaluateEditorialPolicy(cap('Produk keren.'), ctx());
    expect(result.mandatoryFinalHashtagsPresent).toBe(true);
    expect(result.checks.some((c) => c.rule === 'editorial.mandatory_final_hashtags')).toBe(false);
  });

  it('passes despite trailing whitespace/newlines after the ending', () => {
    const result = evaluateEditorialPolicy(`${cap('Produk keren.')}\n\n`, ctx());
    expect(result.mandatoryFinalHashtagsPresent).toBe(true);
  });

  it('rejects a caption missing the ending entirely', () => {
    const result = evaluateEditorialPolicy(cap('Produk keren.').replace('#ai #automation', ''), ctx());
    expect(result.mandatoryFinalHashtagsPresent).toBe(false);
    expect(result.checks.some((c) => c.rule === 'editorial.mandatory_final_hashtags')).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('rejects any text AFTER the ending (nothing may follow)', () => {
    const result = evaluateEditorialPolicy(`${cap('Produk keren.')} Cekidot!`, ctx());
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.rule === 'editorial.mandatory_final_hashtags');
    expect(check?.message).toMatch(/END exactly/);
  });

  it('rejects a trailing punctuation mark after the ending', () => {
    const result = evaluateEditorialPolicy(`${cap('Produk keren.').slice(0, -1)}.`, ctx());
    // Ends with "#ai #automation." — the period is trailing text.
    expect(result.mandatoryFinalHashtagsPresent).toBe(false);
  });

  it('rejects the wrong hashtag order', () => {
    const result = evaluateEditorialPolicy(
      cap('Produk keren.').replace('#ai #automation', '#automation #ai'),
      ctx(),
    );
    expect(result.mandatoryFinalHashtagsPresent).toBe(false);
  });

  it('rejects extra hashtags after the mandatory pair', () => {
    const result = evaluateEditorialPolicy(
      `${cap('Produk keren.')} #extra`,
      ctx(),
    );
    expect(result.mandatoryFinalHashtagsPresent).toBe(false);
  });
});

describe('editorial policy — affiliate disclosure', () => {
  it('rejects disclosure that exists only as a composite hashtag', () => {
    const text = ['Produk keren.', '#ShopeeAffiliate', AFFILIATE_URL, '#ai #automation'].join(
      '\n\n',
    );
    const result = evaluateEditorialPolicy(text, ctx());
    expect(result.disclosurePresent).toBe(false);
    expect(result.checks.some((c) => c.rule === 'editorial.affiliate_disclosure')).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('accepts prose disclosure ("link afiliasi")', () => {
    const result = evaluateEditorialPolicy(cap('Produk keren.'), ctx());
    expect(result.disclosurePresent).toBe(true);
  });
});

describe('editorial policy — normalization', () => {
  it('detects claims regardless of case', () => {
    expect(categoriesOf('AKU PAKAI PRODUK INI TIAP HARI.')).toContain('usage');
    expect(categoriesOf('Aku PaKaI produk ini.')).toContain('usage');
  });

  it('detects claims across extra whitespace and NBSP', () => {
    expect(categoriesOf('Aku   pakai\u00A0produk   ini.')).toContain('usage');
  });

  it('detects claims through NFKC fullwidth normalization', () => {
    expect(categoriesOf('ＡＫＵ ｐａｋａｉ produk ini.')).toContain('usage');
  });

  it('detects claims behind punctuation', () => {
    expect(categoriesOf('Aku, pakai produk ini!')).toContain('usage');
    expect(categoriesOf('aku — pakai produk ini...')).toContain('usage');
  });

  it('normalizeForClaims is NFKC, lower-cased and whitespace-collapsed', () => {
    expect(normalizeForClaims('  AKU\u00A0PAKAI   Produk  ')).toBe('aku pakai produk');
    expect(normalizeForClaims('ＡＫＵ')).toBe('aku');
  });
});

describe('editorial policy — publish-gate issue mapping', () => {
  it('maps checks to ValidationIssues with the right severities', () => {
    const issues = validateEditorial(cap('Aku pakai produk ini.'), ctx());
    expect(issues.every((i) => i.severity === 'error')).toBe(true);
    expect(issues.some((i) => i.rule === 'editorial.no_first_person_claim')).toBe(true);
  });

  it('prefixes non-structural issues with their claim category', () => {
    const issues = validateEditorial(cap('Aku pakai produk ini.'), ctx());
    const claim = issues.find((i) => i.rule === 'editorial.no_first_person_claim');
    expect(claim?.message).toMatch(/^\[usage\]/);
  });

  it('leaves structural (structure-category) messages unprefixed', () => {
    const issues = validateEditorial('Tanpa struktur.', ctx());
    const ending = issues.find((i) => i.rule === 'editorial.mandatory_final_hashtags');
    expect(ending?.message.startsWith('[')).toBe(false);
  });

  it('returns an empty issue list for compliant copy', () => {
    expect(editorialToValidationIssues(evaluateEditorialPolicy(cap('Produk keren.'), ctx()))).toEqual(
      [],
    );
  });
});
