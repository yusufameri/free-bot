/**
 * The deltas the pixel gate keeps, with the pixels that differ and the reason each stands.
 *
 * Order 36's last sentence: an exception lives in `docs/DESIGN-CONTRACT.md` with the pixels that
 * differ and the reason the export wins or the delta stands. This module is the machine-readable
 * copy of that list. `packages/verify/scripts/design-contract.ts` re-exports it as its
 * `DECLARED_DELTAS`, and `packages/pixel-gate/src/deltas.test.ts` asserts this array and the
 * contract's fenced copy are equal, so the prose and the gate cannot drift apart.
 *
 * `field` names a region the gate reports. `pixels` is the literal app-minus-export box delta at
 * each viewport the region is carried on; those are the numbers the entry is about. `allow` lists
 * the distinct magnitudes the entry admits, for a reader and for the design-contract printer.
 *
 * A delta is not a tolerance: the chrome pixel tolerance stays zero, and every region not in this
 * list must agree with the export's box. A new undeclared box delta fails the run.
 */

export interface DeclaredBoxPixels {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface DeclaredDelta {
  readonly field: string;
  readonly allow: readonly number[];
  readonly reason: string;
  readonly pixels: Readonly<Record<string, DeclaredBoxPixels>>;
}

const DESKTOP = ["tablet-landscape", "laptop", "desktop", "wide"] as const;

const ZERO = { left: 0, top: 0, width: 0, height: 0 } as const;

function box(patch: Partial<DeclaredBoxPixels>): DeclaredBoxPixels {
  return { ...ZERO, ...patch };
}

export const DECLARED_BOX_DELTAS: readonly DeclaredDelta[] = [
  {
    field: "pixel-gate content.sidebar-bot-row",
    allow: [8.02],
    reason:
      "The app's first Bot row starts 8.02px higher. Both pages now group their rows under Pinned and Work headings; the remaining difference is the export's 6px brand-row padding and 12px label top against this app's 2px brand padding and 12px label. The row's own 34px height and 9px gap are the export's.",
    pixels: Object.fromEntries(DESKTOP.map((name) => [name, box({ top: -8.02 })])),
  },
  {
    field: "pixel-gate content.center-transcript",
    allow: [0.2, 2.05, 15.76, 6.05],
    reason:
      "Both transcripts start on the header's bottom edge, and the 0.2px top is the export's 55.8px header against this page's 56px. The remaining height difference is the composer band's own box: the app now carries the export's growing textarea, five tool controls and hint row, so the gap is 2.05px at most widths, 6.05px on the desktop viewports and -15.76px at 430, where the export's textarea wraps a line the app's placeholder does not.",
    pixels: {
      "mobile-compact": box({ top: 0.2, height: 2.05 }),
      "mobile-standard": box({ top: 0.2, height: 2.05 }),
      "mobile-large": box({ top: 0.2, height: -15.76 }),
      "foldable-small-tablet": box({ top: 0.2, height: 2.05 }),
      "tablet-portrait": box({ top: 0.2, height: 2.05 }),
      "tablet-landscape": box({ top: 0.2, height: 6.05 }),
      laptop: box({ top: 0.2, height: 6.05 }),
      desktop: box({ top: 0.2, height: 6.05 }),
      wide: box({ top: 0.2, height: 6.05 }),
    },
  },
  {
    field: "pixel-gate content.center-composer",
    allow: [2.25, 15.56, 15.57, 6.25],
    reason:
      "The composer band is pinned to the bottom edge on both pages. The app now carries the export's textarea, five tool controls, Stop run and send, and hint row; the remaining delta is the hint row's line box and the placeholder's own wrap, 2.25px at most widths, 6.25px on the desktop viewports and -15.56px at 430.",
    pixels: {
      "mobile-compact": box({ top: 2.25, height: -2.25 }),
      "mobile-standard": box({ top: 2.25, height: -2.25 }),
      "mobile-large": box({ top: -15.56, height: 15.57 }),
      "foldable-small-tablet": box({ top: 2.25, height: -2.25 }),
      "tablet-portrait": box({ top: 2.25, height: -2.25 }),
      "tablet-landscape": box({ top: 6.25, height: -6.25 }),
      laptop: box({ top: 6.25, height: -6.25 }),
      desktop: box({ top: 6.25, height: -6.25 }),
      wide: box({ top: 6.25, height: -6.25 }),
    },
  },
];

/** The declaration for one region, or undefined when the region is not declared. */
export function declaredBoxDelta(id: string): DeclaredDelta | undefined {
  return DECLARED_BOX_DELTAS.find((entry) => entry.field === `pixel-gate ${id}`);
}
