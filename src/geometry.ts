/**
 * What a deck's controls look like, as the control socket reports it
 * Built from the library's CONTROLS array, so no
 * model is hardcoded here: the positions come from the device.
 */

/** The parts of a control definition this reads. Narrower than the library type on purpose. */
export interface RawControl {
  type: string;
  index?: number;
  row?: number;
  column?: number;
  feedbackType?: string;
  pixelSize?: { width: number; height: number };
  columnSpan?: number;
  rowSpan?: number;
}

export interface GeometrySource {
  MODEL?: string;
  PRODUCT_NAME?: string;
  CONTROLS?: ReadonlyArray<RawControl>;
}

export interface KeyPosition {
  index: number;
  row: number;
  column: number;
  /** 'lcd' keys have a screen; 'rgb' and 'none' do not. */
  feedback: string;
}

/**
 * Names the library gives two different products, so it cannot tell them apart
 * (see `MODEL_NAMES` in
 * `@elgato-stream-deck/core/dist/id.js`: both `original` and `originalv2` are
 * "Stream Deck"). Only ambiguous models are listed; every other model keeps the
 * library's own name, so a deck this table has never heard of is unaffected and
 * nothing here is load-bearing for behaviour — geometry still comes from
 * CONTROLS.
 */
const AMBIGUOUS_MODEL_NAMES: Record<string, string> = {
  original: 'Stream Deck Original',
  originalv2: 'Stream Deck Original V2',
};

export function productNameFor(model: string, libraryName: unknown): string {
  return AMBIGUOUS_MODEL_NAMES[model] ?? String(libraryName ?? model ?? 'unknown');
}

export interface DeckGeometry {
  /** The library's model id, e.g. "xl". */
  model: string;
  /** e.g. "Stream Deck XL". */
  productName: string;
  keyCount: number;
  /** Width in pixels of the keys' screens, or null if no key has one. */
  iconSize: number | null;
  /** Rows and columns covering every control, spans included. */
  rows: number;
  columns: number;
  keys: KeyPosition[];
  /** Controls that are not buttons (encoders, LCD segments), as the library describes them. */
  unsupported: Array<Record<string, unknown>>;
}

export function geometryOf(source: GeometrySource): DeckGeometry {
  const controls = source.CONTROLS ?? [];
  const keys: KeyPosition[] = [];
  const unsupported: Array<Record<string, unknown>> = [];
  let rows = 0;
  let columns = 0;
  let iconSize: number | null = null;

  for (const control of controls) {
    const row = control.row ?? 0;
    const column = control.column ?? 0;
    rows = Math.max(rows, row + (control.rowSpan ?? 1));
    columns = Math.max(columns, column + (control.columnSpan ?? 1));

    if (control.type === 'button' && typeof control.index === 'number') {
      const feedback = control.feedbackType ?? 'none';
      keys.push({ index: control.index, row, column, feedback });
      if (iconSize === null && feedback === 'lcd' && control.pixelSize) iconSize = control.pixelSize.width;
      continue;
    }

    const entry: Record<string, unknown> = { type: control.type, row, column };
    if (typeof control.index === 'number') entry.index = control.index;
    if (control.columnSpan !== undefined) entry.columnSpan = control.columnSpan;
    if (control.rowSpan !== undefined) entry.rowSpan = control.rowSpan;
    unsupported.push(entry);
  }

  keys.sort((a, b) => a.index - b.index);
  return {
    model: String(source.MODEL ?? 'unknown'),
    productName: productNameFor(String(source.MODEL ?? ''), source.PRODUCT_NAME),
    keyCount: keys.length > 0 ? keys[keys.length - 1].index + 1 : 0,
    iconSize,
    rows,
    columns,
    keys,
    unsupported,
  };
}
