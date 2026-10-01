// Starter design so the app works (compile, sliders, viewer) before an API key is set.
export const EXAMPLE_KNOB = `// Replacement stove knob with D-shaped shaft
/* [Knob] */
knob_diameter = 38; // [20:0.5:60] Outer diameter of the knob
knob_height = 22; // [10:0.5:40] Total height
grip_count = 18; // [0:1:40] Number of finger grips around the edge
grip_depth = 1.2; // [0:0.1:3] Depth of each grip notch
pointer = true; // Raised pointer line on top

/* [Shaft] */
shaft_diameter = 6; // [3:0.05:10] Shaft diameter (measure with calipers)
shaft_flat = 4.6; // [2:0.05:10] Distance from flat to opposite side
shaft_depth = 14; // [5:0.5:30] How deep the shaft goes into the knob
clearance = 0.2; // [0:0.05:0.6] Extra gap per side for fit

/* [Quality] */
fn = 96; // [24:8:192] Smoothness of round surfaces

/* [Hidden] */
$fn = fn;
top_chamfer = 2;

module body() {
  difference() {
    union() {
      cylinder(d = knob_diameter, h = knob_height - top_chamfer);
      translate([0, 0, knob_height - top_chamfer])
        cylinder(d1 = knob_diameter, d2 = knob_diameter - 2 * top_chamfer, h = top_chamfer);
    }
    // Finger grips
    if (grip_count > 0)
      for (i = [0 : grip_count - 1])
        rotate([0, 0, i * 360 / grip_count])
          translate([knob_diameter / 2 + 1.5 - grip_depth, 0, -1])
            cylinder(r = 1.5 + 0.01, h = knob_height + 2, $fn = 24);
  }
}

module d_shaft() {
  d = shaft_diameter + 2 * clearance;
  f = shaft_flat + 2 * clearance;
  translate([0, 0, -1])
    intersection() {
      cylinder(d = d, h = shaft_depth + 1);
      translate([-d / 2, -d / 2 + (d - f), 0]) cube([d, d, shaft_depth + 1]);
    }
}

difference() {
  body();
  d_shaft();
}
if (pointer)
  translate([-1.2, 3, knob_height - 0.01])
    cube([2.4, knob_diameter / 2 - top_chamfer - 4, 1.2]);
`;
