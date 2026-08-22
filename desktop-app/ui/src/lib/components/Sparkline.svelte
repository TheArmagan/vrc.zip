<!--
  A request-rate sparkline: a minute of one-second buckets, drawn small.

  Three decisions carry the whole thing, and the first two were wrong in the first version.

  **It scales to its own peak, not to the rate limit.** Drawing a 3/s series against an 80/s ceiling
  puts every point in the bottom 4% of the box, which renders as a flat line — technically honest
  about headroom and useless for the question anyone actually has, which is "what is the shape of
  this". The magnitude lives in the number printed beside it; the picture is for the shape. `max`
  still exists for the case where several charts must share a scale to be comparable.

  **Resolution follows the element, not a constant.** A fixed column count once collapsed the
  window into far fewer columns than it had buckets, so a one-second spike came out as a plateau and
  everything looked blocky. The width is measured and the series is resampled at `density` columns
  per CSS pixel — which at the current window means the cap below usually wins and every second gets
  its own column, nothing averaged at all.

  **Downsampled by maximum, and drawn as steps.** Averaging turns a one-second burst of 20 into a
  column of 4, flattening exactly the shape worth seeing — a spike is what gets the user
  rate-limited. And a straight line between two buckets implies readings that were never taken;
  these are counts per discrete second, so the honest rendering is a step.

  Plain SVG, no dependency and no canvas: a few hundred numbers re-rendered once a second.
-->
<script lang="ts">
let {
  values,
  /** Force a shared ceiling across several charts. Null scales each to its own peak. */
  max = null,
  height = 28,
  /**
   * Columns per CSS pixel.
   *
   * Above 1 because these are drawn small: at 3 even a 20-pixel chart asks for more columns than a
   * one-minute window has buckets, so the cap below wins and every second is drawn on its own —
   * which is the most faithful the chart can be. `preserveAspectRatio="none"` stretches the viewBox
   * to fit, so sub-pixel columns cost nothing but a slightly longer path string.
   */
  density = 3,
  class: className = "",
  label = "Requests per second",
}: {
  values: readonly number[];
  max?: number | null;
  height?: number;
  density?: number;
  class?: string;
  label?: string;
} = $props();

/** The rendered width, so resolution can follow it. 0 until the first layout pass. */
let boxWidth = $state(0);

/**
 * How many columns to resample into.
 *
 * Never more than there are buckets — upsampling would draw steps that are pure interpolation —
 * and never zero, which would divide by nothing below.
 */
const columns = $derived(
  Math.max(1, Math.min(values.length || 1, Math.round(Math.max(boxWidth, 1) * density))),
);

/** Buckets collapsed to `columns` points, each the busiest second it covers. */
const points = $derived.by(() => {
  if (values.length === 0) return [] as number[];
  const out = new Array<number>(columns).fill(0);
  // Walk the source once and place each bucket in its column, rather than slicing per column:
  // the ratio is rarely an integer, and rounding per column drops or double-counts buckets at the
  // seams — which shows up as a spike that moves by a pixel each second and never settles.
  for (let i = 0; i < values.length; i += 1) {
    const column = Math.min(columns - 1, Math.floor((i * columns) / values.length));
    const value = values[i] ?? 0;
    if (value > (out[column] ?? 0)) out[column] = value;
  }
  return out;
});

const scale = $derived.by(() => {
  const own = points.reduce((peak, value) => (value > peak ? value : peak), 0);
  const ceiling = max !== null && max > 0 ? max : own;
  // Never zero: a flat line of zeroes renders along the bottom rather than dividing by nothing.
  return ceiling > 0 ? ceiling : 1;
});

/**
 * The step outline, in a viewBox one unit per column.
 *
 * A tiny inset at the top keeps the peak's stroke inside the box instead of clipped in half by the
 * edge, which is what made a saturated series look like it had no line at all.
 */
const geometry = $derived.by(() => {
  if (points.length === 0) return { line: "", area: "" };

  const inset = 1;
  const y = (value: number): number => height - inset - (value / scale) * (height - inset);

  let line = "";
  for (let i = 0; i < points.length; i += 1) {
    const at = y(points[i] ?? 0);
    // Flat across the column, then a vertical to the next one: a count is a step, not a slope.
    line += i === 0 ? `M${String(i)},${String(at)}` : ` L${String(i)},${String(at)}`;
    line += ` L${String(i + 1)},${String(at)}`;
  }

  return {
    line,
    area: `${line} L${String(points.length)},${String(height)} L0,${String(height)} Z`,
  };
});
</script>

<div class="w-full {className}" bind:clientWidth={boxWidth}>
  <svg
    class="block w-full"
    style="height: {height}px"
    viewBox="0 0 {Math.max(points.length, 1)} {height}"
    preserveAspectRatio="none"
    role="img"
    aria-label={label}
  >
    <path d={geometry.area} class="fill-primary/15" />
    <path
      d={geometry.line}
      class="stroke-primary"
      fill="none"
      stroke-width="1.25"
      stroke-linejoin="round"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</div>
