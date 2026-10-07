/**
 * The execution-line quantity columns are NUMERIC(14,3): at most three
 * decimal places and a maximum magnitude of 99,999,999,999.999. Validate
 * before PostgreSQL coerces an input into that column so accepted values are
 * never silently rounded.
 */
export const HANDYMAN_MATERIAL_QUANTITY_SCALE = 3;
export const HANDYMAN_MATERIAL_QUANTITY_MAX = 99_999_999_999.999;
const HANDYMAN_MATERIAL_QUANTITY_FACTOR = 10 ** HANDYMAN_MATERIAL_QUANTITY_SCALE;

export function isHandymanMaterialQuantityRepresentable(
  value: unknown,
): value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > HANDYMAN_MATERIAL_QUANTITY_MAX
  ) {
    return false;
  }
  return Number(value.toFixed(HANDYMAN_MATERIAL_QUANTITY_SCALE)) === value;
}

/** Inputs accepted above can be safely converted to exact thousandths. */
export function handymanMaterialQuantityUnits(value: number): number {
  return Math.round(value * HANDYMAN_MATERIAL_QUANTITY_FACTOR);
}

export function handymanMaterialQuantityFromUnits(units: number): number {
  return units / HANDYMAN_MATERIAL_QUANTITY_FACTOR;
}
