/**
 * Product-faithful image prompt construction (Part 3).
 *
 * The selected product is the SOURCE OF TRUTH for every prompt. The builder
 * passes through only VERIFIED catalog fields (name, category, and the real
 * reference image URL) and explicitly instructs the model to preserve the
 * product's physical identity — packaging shape, color, brand/label as
 * visible in the reference — while NEVER inventing packaging text, logos,
 * ingredients, specifications or benefits.
 *
 * Prompt versioning: every asset records `PROMPT_VERSION`, so a later audit
 * can tell which prompt template produced which image.
 *
 * HONESTY NOTE: a well-formed prompt does not guarantee product fidelity.
 * Fidelity can only be APPROXIMATED without a vision-verification step; the
 * pipeline therefore records the reference URL + prompt + validation results
 * and the report must not present "provider accepted the request" as proof of
 * fidelity. See image-quality.ts for the (limited) automated checks.
 */
import type { CatalogProduct } from '../catalog/catalog.js';

export const PROMPT_VERSION = 'part3-v1';

export type ImageView = 'main_closeup_pov' | 'secondary_lifestyle';

export interface ImagePrompt {
  readonly prompt: string;
  readonly negativePrompt: string;
  readonly promptVersion: string;
}

const SHARED_STYLE = [
  'premium vertical product photography, realistic natural lighting,',
  'shallow depth of field, clean uncluttered background,',
  'photorealistic, high detail, commercial catalogue quality',
].join(' ');

const NEGATIVE = [
  'distorted hands, extra fingers, deformed anatomy,',
  'text not present on the real product, invented logos,',
  'invented packaging labels, watermarks, low resolution,',
  'blurry main subject, cartoon, illustration, 3d render look',
].join(' ');

/**
 * Build the generation prompt for one view of a product.
 *
 * Only verified catalog data is embedded. When the feed provides no category
 * the prompt simply omits it — it never guesses a product type.
 */
export function buildImagePrompt(
  product: CatalogProduct,
  view: ImageView,
  seed: number,
): ImagePrompt {
  const identity = [
    `Product: ${product.name}.`,
    product.category ? `Product category: ${product.category}.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const fidelity =
    'Depict EXACTLY this product. Preserve its packaging shape, main color, ' +
    'brand and label appearance exactly as shown in the reference image. ' +
    'Do not invent packaging text, logos, ingredients, specifications, ' +
    'benefits, discounts or claims. If a detail is not visible in the ' +
    'reference, keep it generic rather than inventing it.';

  const composition =
    view === 'main_closeup_pov'
      ? 'Composition: a natural human hand holding the product in a first-person ' +
        'point-of-view close-up, fingers anatomically correct, product centered ' +
        'and in sharp focus, soft daylight.'
      : 'Composition: the SAME product placed in a simple, consistent everyday ' +
        'lifestyle setting (desk or shelf), complementary angle to the close-up, ' +
        'same lighting mood and color palette, product fully visible and in focus.';

  return {
    prompt: [identity, fidelity, composition, `Style: ${SHARED_STYLE}.`, `Seed: ${seed}.`]
      .filter(Boolean)
      .join(' '),
    negativePrompt: NEGATIVE,
    promptVersion: PROMPT_VERSION,
  };
}
