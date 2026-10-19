'use strict';
// A dashboard's FormXML, shaped like the ones the platform stores, for the tests that drive the REAL bundle over a
// dashboard (download-dashboard-custom-control.test.js, verify-dashboard-custom-control.test.js): one tab and one section
// of four equal columns, a row per group of tiles, the control descriptions after the tabs, and the access element last.
//
// The class of a native grid or chart tile, spelled as the platform writes it in a dashboard (the case varies between
// sources), and the class every custom control shares.
const NATIVE_CLASS = '{E7A81278-8635-4d9e-8D4D-59480B391C5B}';
const CUSTOM_CLASS = '{F9A8A302-114E-466A-B582-6771B2AE0D92}';
const IFRAME_CLASS = '{FD2A7985-3187-444E-908D-6624B21F69C0}';
const WEB_RESOURCE_CLASS = '{9FDF5F91-88B1-47F4-AD53-C11EFC01A01D}';
// The uniqueid that makes a control on the custom-control class the Assistant, and not a grid or chart a custom control hosts.
const ASSISTANT_UNIQUE_ID = '3ff9a528-dd50-4aca-8f10-2e5ed73513ad';

// A tile's parameters, in the platform's order. `mode` is `Grid` or `Chart`.
const gridParameters = ({ mode = 'Grid', view, chart = '' }) => `<parameters><TargetEntityType>incident</TargetEntityType><ChartGridMode>${mode}</ChartGridMode>`
  + '<EnableQuickFind>true</EnableQuickFind><EnableViewPicker>true</EnableViewPicker><EnableJumpBar>true</EnableJumpBar><RecordsPerPage>8</RecordsPerPage>'
  + `<HeaderColorCode>#F3F3F3</HeaderColorCode><ViewId>{${view}}</ViewId><IsUserView>false</IsUserView><ViewIds>{${view}}</ViewIds><AutoExpand>Fixed</AutoExpand>`
  + `<VisualizationId>${chart ? `{${chart}}` : ''}</VisualizationId><IsUserChart>false</IsUserChart><EnableChartPicker>${chart ? 'true' : 'false'}</EnableChartPicker><RelationshipName /></parameters>`;

let cells = 0;
const cell = (label, control, { colspan = 2, rowspan = 8 } = {}) => {
  cells += 1;
  return `<cell colspan="${colspan}" rowspan="${rowspan}" showlabel="false" id="{aaaaaaaa-0000-4000-8000-${String(cells).padStart(12, '0')}}" auto="false">`
    + `<labels><label description="${label}" languagecode="1033" /></labels>${control}</cell>`;
};
const nativeGrid = (id, label, view) => cell(label, `<control id="${id}" classid="${NATIVE_CLASS}" indicationOfSubgrid="true">${gridParameters({ view })}</control>`);
const nativeChart = (id, label, view, chart) => cell(label, `<control id="${id}" classid="${NATIVE_CLASS}" indicationOfSubgrid="true">${gridParameters({ mode: 'Chart', view, chart })}</control>`);
// A grid or a chart a custom control hosts: the custom-control class and the control's own `uniqueid`, the grid parameters
// of a native tile, and a description of the hosted control among the dashboard's `controlDescriptions` (see dashboardXml).
const customGrid = (id, label, view, uniqueId) => cell(label, `<control id="${id}" classid="${CUSTOM_CLASS}" uniqueid="{${uniqueId}}" indicationOfSubgrid="true">${gridParameters({ view })}</control>`);
const customChart = (id, label, view, chart, uniqueId) => cell(label, `<control id="${id}" classid="${CUSTOM_CLASS}" uniqueid="{${uniqueId}}" indicationOfSubgrid="true">${gridParameters({ mode: 'Chart', view, chart })}</control>`);
// The Assistant: the custom-control class again, with its own uniqueid and none of the grid parameters.
const assistantTile = (id, label) => cell(label, `<control id="${id}" classid="${CUSTOM_CLASS}" uniqueid="{${ASSISTANT_UNIQUE_ID}}"><parameters /></control>`);
// Any other custom control: the custom-control class with a uniqueid of its own and no grid markers, so it is no grid or chart.
const otherCustomControl = (id, label, uniqueId) => cell(label, `<control id="${id}" classid="${CUSTOM_CLASS}" uniqueid="{${uniqueId}}"><parameters><Mode>compact</Mode></parameters></control>`);
const iframeTile = (id, label, url) => cell(label, `<control id="${id}" classid="${IFRAME_CLASS}"><parameters><Url>${url}</Url><PassParameters>false</PassParameters><Security>false</Security><Scrolling>auto</Scrolling><Border>true</Border></parameters></control>`, { colspan: 4, rowspan: 6 });
const webResourceTile = (id, label, name) => cell(label, `<control id="${id}" classid="${WEB_RESOURCE_CLASS}"><parameters><WebResourceName>${name}</WebResourceName><Url>${name}</Url><PassParameters>false</PassParameters><Security>false</Security><Scrolling>auto</Scrolling><Border>true</Border></parameters></control>`, { colspan: 4, rowspan: 6 });

const customDescription = (uniqueId, view) => `<controlDescription forControl="{${uniqueId}}"><customControl formFactor="0" name="MscrmControls.Grid.GridControl"><parameters>`
  + `<ViewId>{${view}}</ViewId><IsUserView>false</IsUserView><TargetEntityType>incident</TargetEntityType></parameters></customControl></controlDescription>`;

// `rows` is a list of rows, each a list of cells built by the functions above; `descriptions` are the control descriptions.
function dashboardXml(rows, descriptions = []) {
  cells = 0;
  const body = rows.map((row) => `<row>${row.join('')}</row>`).join('');
  return '<form><tabs><tab verticallayout="true" id="{bbbbbbbb-0000-4000-8000-000000000001}"><labels><label description="Tab" languagecode="1033" /></labels>'
    + '<columns><column width="100%"><sections><section showlabel="false" showbar="false" columns="1111" id="{bbbbbbbb-0000-4000-8000-000000000002}">'
    + `<labels><label description="Section" languagecode="1033" /></labels><rows>${body}</rows></section></sections></column></columns></tab></tabs>`
    + `<controlDescriptions>${descriptions.join('')}</controlDescriptions><DisplayConditions FallbackForm="true"><Everyone /></DisplayConditions></form>`;
}

module.exports = {
  NATIVE_CLASS, CUSTOM_CLASS, IFRAME_CLASS, WEB_RESOURCE_CLASS, ASSISTANT_UNIQUE_ID,
  nativeGrid, nativeChart, customGrid, customChart, assistantTile, otherCustomControl, iframeTile, webResourceTile, customDescription, dashboardXml,
};
