// Prompts aprobados. Van en inglés porque los modelos de imagen obedecen mejor.
const COMMON =
  'Edit the provided photo of a clothing item. Keep the garment EXACTLY as it is: same color, fabric texture, shape, proportions, logos, prints, text, labels, stitching, buttons, zippers and any real wear or flaws. Do not redraw, restyle, add, remove, translate or distort any text or logo. Keep the same side of the garment shown in the original photo. Show only this garment: no people, mannequins or other objects. Photorealistic, soft even studio lighting, sharp focus, natural realistic shadows. Square 1:1 composition, garment centered and fully visible with some margin. If the photo is a close-up of a detail (label, logo, fabric), keep that close framing and only replace the background.';

const STYLES = {
  HANGER:
    'Show the garment hanging from a simple neutral hanger, hooked to a wall-mounted hook, against a plain professional light-to-medium gray wall. The garment hangs naturally and neatly, with its shape held by the hanger and no distracting wrinkles. Soft shadow cast on the wall behind it.',
  SURFACE:
    'Show the garment lying flat, neatly arranged and smoothed, on a plain professional light-to-medium gray surface, photographed from directly above. Edges and sleeves tidy and symmetrical, with a subtle natural shadow underneath.',
};

export const isStyle = (s) => s in STYLES;

export function buildPrompt(style, refinement) {
  let p = `${COMMON} ${STYLES[style]}`;
  if (refinement?.trim()) p += ` Additional adjustment requested by the user: ${refinement.trim()}`;
  return p;
}
