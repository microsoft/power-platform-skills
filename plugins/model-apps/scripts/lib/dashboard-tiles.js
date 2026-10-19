'use strict';
// Which tile of a DEPLOYED dashboard a custom control hosts. One classification, shared by the download (which leaves such a tile
// out of the spec) and by verify (which does not hold it to the chart and view the spec's own tiles name), so the two cannot
// disagree about what the App Spec can describe.
//
// The SDK types a tile by its control's class, and reads a grid or a chart that a CUSTOM control hosts (the Power Apps grid, say) by
// the grid parameters it carries (`ChartGridMode`, or `indicationOfSubgrid`) — as `list` or `chart`, exactly as it does a native
// tile, with the same `TargetEntityType`, `ViewId` and `ChartGridMode`. Only its class tells them apart:
//   <control id="Component1" classid="{E7A81278-8635-4d9e-8D4D-59480B391C5B}" indicationOfSubgrid="true">                       native
//   <control id="Component2" classid="{F9A8A302-114E-466A-B582-6771B2AE0D92}" uniqueid="{GUID}" indicationOfSubgrid="true">    hosted
// The platform writes the GUID in either case, and with its braces, so the class is compared without them and ignoring case.
//
// Documented dashboards hold charts, grids, iframes and web resources, which is all the App Spec expresses; a control of another
// class is not among them. So the download must not emit it as the plain grid or chart its parameters describe (that replaces the
// control wherever a rebuild creates the dashboard), and verify must not judge it as one (the chart and view it carries are not
// ones the spec declares, and the build never touches the tile).
//
// A component with no class at all (a hand-made one, in a test) is read as native.
// See: https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/understand-dashboards-dashboard-components-formxml

// The control class of a native grid and chart tile, in the bare upper-case form `bareClassId` makes of any spelling.
const NATIVE_GRID_CLASS_ID = 'E7A81278-8635-4D9E-8D4D-59480B391C5B';

const bareClassId = (id) => String(id || '').replace(/[{}]/g, '').toUpperCase();

/**
 * True for a tile typed `list` or `chart` whose control is not the native grid and chart control: a grid or a chart that a custom
 * control hosts. False for a native tile, for a tile of any other type (the Assistant, an iframe, a web resource, a custom control
 * that is no grid or chart), and for a component with no class.
 * @param {{ type?: string, classId?: string } | null | undefined} component - a component of the SDK's typed dashboard
 */
function hostsCustomControl(component) {
  if (!component || (component.type !== 'chart' && component.type !== 'list')) return false;
  const classId = bareClassId(component.classId);
  return classId !== '' && classId !== NATIVE_GRID_CLASS_ID;
}

module.exports = { NATIVE_GRID_CLASS_ID, hostsCustomControl };
