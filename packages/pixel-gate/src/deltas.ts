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
    field: "pixel-gate content.sidebar-list",
    allow: [78],
    reason:
      "The app's list ends 78px lower than the export's. The export's foot is 125px: Connect apps, the model row and the account row. This app's foot is 47px: the one provider row. The account and the apps surface have no record in this build, so the list takes the space they would occupy; the head's own 2px start delta was closed by adopting the export's 10px head padding and 2px list inset.",
    pixels: Object.fromEntries(DESKTOP.map((name) => [name, box({ height: 78 })])),
  },
  {
    field: "pixel-gate content.sidebar-bot-row",
    allow: [32.25],
    reason:
      "The app's first Bot row starts 32.25px higher. The export groups its rows under Pinned, Primary and Unassigned labels (freebot-prototype.html:984-993) and this app renders one Bots heading, because the Bot record holds no group, pinned or primary field; the row's own 34px height and 9px gap are the export's.",
    pixels: Object.fromEntries(DESKTOP.map((name) => [name, box({ top: -32.25 })])),
  },
  {
    field: "pixel-gate content.center-transcript",
    allow: [0.2, 70.3, 52.49, 56.49],
    reason:
      "Both transcripts start on the header's bottom edge (the 0.2px top is the export's 55.8px header against this page's 56px) and end on the composer's top edge. This app's transcript is taller by the amount its composer is shorter, because the export's composer carries a growing textarea, a five-control tools row and a hint row while this app's carries one input, two buttons and the live stream line. The `flex: 1` transcript and the bottom-pinned composer are the export's own order.",
    pixels: {
      "mobile-compact": box({ top: 0.2, height: 70.3 }),
      "mobile-standard": box({ top: 0.2, height: 70.3 }),
      "mobile-large": box({ top: 0.2, height: 52.49 }),
      "foldable-small-tablet": box({ top: 0.2, height: 52.49 }),
      "tablet-portrait": box({ top: 0.2, height: 52.49 }),
      "tablet-landscape": box({ top: 0.2, height: 56.49 }),
      laptop: box({ top: 0.2, height: 56.49 }),
      desktop: box({ top: 0.2, height: 56.49 }),
      wide: box({ top: 0.2, height: 56.49 }),
    },
  },
  {
    field: "pixel-gate content.center-composer",
    allow: [70.5, 52.69, 56.69, 52.68, 56.68],
    reason:
      "The composer band is pinned to the bottom edge on both pages, so the app's top edge sits lower and its height is smaller by the same amount. The export's band is 146.06px at 1920 and 159.88px at 360; this app's is 89.38px at 1920 and 89.38px at 360, because the product's composer is one input, a Start and a Stop control and the stream's own meta line against the export's textarea, five tool controls and hint. Control count and copy are named in `docs/DESIGN-CONTRACT.md`; the bottom edge is identical.",
    pixels: {
      "mobile-compact": box({ top: 70.5, height: -70.5 }),
      "mobile-standard": box({ top: 70.5, height: -70.5 }),
      "mobile-large": box({ top: 52.69, height: -52.68 }),
      "foldable-small-tablet": box({ top: 52.69, height: -52.68 }),
      "tablet-portrait": box({ top: 52.69, height: -52.68 }),
      "tablet-landscape": box({ top: 56.69, height: -56.68 }),
      laptop: box({ top: 56.69, height: -56.68 }),
      desktop: box({ top: 56.69, height: -56.68 }),
      wide: box({ top: 56.69, height: -56.68 }),
    },
  },
];

/** The declaration for one region, or undefined when the region is not declared. */
export function declaredBoxDelta(id: string): DeclaredDelta | undefined {
  return DECLARED_BOX_DELTAS.find((entry) => entry.field === `pixel-gate ${id}`);
}
