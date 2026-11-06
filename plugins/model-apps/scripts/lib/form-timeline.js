'use strict';
// The shape Dynamics renders a form's Timeline (activity timeline + notes) control in. One definition,
// shared by the compiler (artifact-intent.js), the build's in-place repair of a host an older version
// wrote (sdk-build.js) and `--verify` (verify-spec.js), so the three cannot disagree about what a working
// timeline looks like.
//
// WHY it is more than "one control in a cell". The Notes section used to carry the timeline as an
// ordinary unbound control:
//   <cell id="{…}" showlabel="false" visible="true" colspan="1" rowspan="1"><labels>…</labels>
//     <control id="{generated-guid}" classid="{06375649-C143-495E-A496-C962E5B4488E}" disabled="false" isrequired="false" /></cell>
// Dynamics published that and never rendered it. The timeline on every platform form (Account, Contact, …)
// instead has the FIXED control id `notescontrol`, sits in a cell with `showlabel="false"` that is TALL, and is
// followed by empty spacer rows the cell spans — a cell of `rowspan` N is followed by N-1 empty rows:
//   <row><cell id="{…}" showlabel="false" colspan="1" rowspan="23" auto="false"><labels>…</labels>
//     <control id="notescontrol" classid="{06375649-C143-495E-A496-C962E5B4488E}" disabled="false" /></cell></row>
//   <row /><row /> … 22 empty rows
// N is not fixed: platform forms use 5, 20, 23 and others, and a maker can resize the timeline in the designer.
// `auto="false"` is on some platform timelines and absent on others, and `colspan` is 1 or 2. So what is shared —
// and what is judged and converged here — is the id, a span of two rows or more, and the rows that back the span;
// the build writes 23 and `auto="false"` for a host it creates, the shape known to render, and
// never overrides a span or a width a maker chose.
// Changing only the control id, the cell (`rowspan="23"`, `auto="false"`) and the spacer rows on a generated
// form made the timeline render at once, so those are the parts written here. `auto` is a documented boolean
// on a section cell, but the schema says nothing about what it means:
// https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/form-xml-schema
//
// PURE: no I/O, no SDK. The helpers read both tree shapes this plugin handles — the SDK's form artifact
// (tabs → columns → sections → rows → cells, a cell's own attributes in `bag.a`) and verify's parse of
// published FormXML (the same nesting, a cell's `auto` as a plain property) — because both name the parts
// they share the same way.

const { entityByLogical } = require('./_graph.js');

// The platform's class id for the Timeline control (the SDK's ControlClassIds.TimelineControl).
const TIMELINE_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E';
// The one control id Dynamics renders a timeline under.
const TIMELINE_CONTROL_ID = 'notescontrol';
// A timeline cell spans this many rows: its own and TIMELINE_ROWSPAN - 1 empty spacer rows after it.
const TIMELINE_ROWSPAN = 23;
// What the build writes for the cell's `auto` attribute.
const TIMELINE_AUTO = 'false';

// A class id as compared: the SDK projects `classid` without braces in its original case, FormXML carries
// it in braces, and the compiler writes the constant in upper case.
const sameId = (a, b) => String(a == null ? '' : a).replace(/[{}]/g, '').trim().toLowerCase()
  === String(b == null ? '' : b).replace(/[{}]/g, '').trim().toLowerCase();

// An unbound control of the timeline's class. A bound control's class id comes from its attribute's type,
// so an unbound one with this class id is the timeline itself.
function isTimelineControl(control) {
  return !!control && !control.fieldName && sameId(control.classId, TIMELINE_CLASS_ID);
}

// The cell the compiler writes for the timeline, as the SDK's generic surface takes it.
//
// The control id and the row span are typed fields the SDK honours as given (it only mints an id when one is
// absent). `auto` is not modelled by a cell, so it travels in the cell's bag of own attributes — and the
// moment a bag carries ANY attribute the SDK treats the cell as fetched: it keeps the bag verbatim and omits
// every typed attribute that equals its default (`showlabel="false"`, `colspan="1"`). The platform's forms
// spell those out, so they are written into the bag too; the typed values agree with them, and where a
// typed value ever differs, the typed one wins on serialize.
function timelineCellIntent(classId) {
  return {
    rowspan: TIMELINE_ROWSPAN,
    bag: {
      a: [['showlabel', 'false'], ['colspan', '1'], ['rowspan', String(TIMELINE_ROWSPAN)], ['auto', TIMELINE_AUTO]],
      c: [],
    },
    control: {
      id: TIMELINE_CONTROL_ID,
      classId: String(classId),
      fieldName: null,
      label: 'Notes',
      showLabel: false,
      parameters: {},
    },
  };
}

// The rows of a new timeline host: the timeline's row, then the empty rows its cell spans. An empty
// `{ cells: [] }` serializes as `<row />`, which is how the platform's forms write a spacer row.
function timelineRowsIntent(classId) {
  const rows = [{ cells: [timelineCellIntent(classId)] }];
  for (let i = 1; i < TIMELINE_ROWSPAN; i += 1) rows.push({ cells: [] });
  return rows;
}

// Whether a form asks for the timeline: its own `notes: true`, or `hasNotes: true` on its table. Main forms
// only — the platform's quick-create and quick-view forms do not host one.
function wantsTimeline(spec, formSpec) {
  if (!formSpec || (formSpec.formType || 'Main') !== 'Main') return false;
  if (formSpec.notes === true) return true;
  const entity = entityByLogical(spec, String(formSpec.entity || '').toLowerCase());
  return !!(entity && entity.hasNotes === true);
}

// A cell's own `auto` attribute, whichever tree shape it comes from.
function cellAuto(cell) {
  if (!cell) return undefined;
  if (cell.auto !== undefined) return String(cell.auto);
  const pair = ((cell.bag && cell.bag.a) || []).find((p) => Array.isArray(p) && p[0] === 'auto');
  return pair ? String(pair[1]) : undefined;
}

// Where the timeline control sits in one section, or null. `others` are the section's other cells and `onlyCell`
// says there are none, the one shape the build repairs in place; `rowsBelow` counts the rows after the timeline's own.
function timelineInSection(section) {
  const rows = (section && section.rows) || [];
  let found = null;
  const cells = [];
  rows.forEach((row, rowIndex) => {
    ((row && row.cells) || []).forEach((cell, cellIndex) => {
      cells.push(cell);
      if (!found && cell && isTimelineControl(cell.control)) {
        found = { rowIndex, cellIndex, cell, control: cell.control, rowspan: Number(cell.rowspan) || 1, auto: cellAuto(cell), id: cell.control.id };
      }
    });
  });
  if (!found) return null;
  const others = cells.filter((cell) => cell !== found.cell);
  return Object.assign(found, { rowsBelow: rows.length - 1 - found.rowIndex, onlyCell: others.length === 0, others });
}

// Every timeline control on a form, in document order, each with where it is: { ti, ci, si, section, … }
// plus what timelineInSection reports. `tabs` is the form's tabs array in either tree shape.
function timelinesOf(tabs) {
  const out = [];
  (tabs || []).forEach((tab, ti) => ((tab && tab.columns) || []).forEach((column, ci) => ((column && column.sections) || []).forEach((section, si) => {
    const found = timelineInSection(section);
    if (found) out.push(Object.assign({ ti, ci, si, section }, found));
  })));
  return out;
}

// Whether any control on the form (a timeline or not) already uses `id`, other than `except`. Control ids are
// names the platform's scripts and designer address, so a second `notescontrol` would be a duplicate.
function controlIdTaken(tabs, id, except) {
  const want = String(id).toLowerCase();
  for (const tab of tabs || []) for (const column of (tab && tab.columns) || []) for (const section of (column && column.sections) || []) {
    for (const row of (section && section.rows) || []) for (const cell of (row && row.cells) || []) {
      const control = cell && cell.control;
      if (control && control !== except && String(control.id == null ? '' : control.id).toLowerCase() === want) return true;
    }
  }
  return false;
}

// What a timeline still lacks of the platform's shape, as the build writes it: `{}` when it has all of it.
//   id        the control id to write
//   rowspan   the cell span to write — kept when the cell is already tall (a maker may have sized it)
//   addRows   empty rows to append after the timeline's row so the span is backed by rows
//   auto      the `auto` attribute to write
// Any span of two rows or more is a working height: platform forms differ (5, 20, 23, …) and a maker may resize
// the timeline, so a cell of N rows with the N-1 rows under it lacks nothing, and only a one-row cell is raised
// to the platform's 23. Rows are only ever ADDED, up to what the span needs — an extra row a resize left behind
// is not the build's to delete.
function timelineRepairPlan(found) {
  const plan = {};
  if (found.id !== TIMELINE_CONTROL_ID) plan.id = TIMELINE_CONTROL_ID;
  const rowspan = found.rowspan >= 2 ? found.rowspan : TIMELINE_ROWSPAN;
  if (rowspan !== found.rowspan) plan.rowspan = rowspan;
  if (found.rowsBelow < rowspan - 1) plan.addRows = rowspan - 1 - found.rowsBelow;
  // `auto="false"` is on some platform timelines and not on others, so its absence is no defect and never a reason
  // to write by itself. It goes in WITH the conversion of a cell an older build wrote (a new id or a new span) —
  // the shape known to render — and a cell that only lacks rows is otherwise left as it is.
  if ((plan.id !== undefined || plan.rowspan !== undefined) && found.auto !== TIMELINE_AUTO) plan.auto = TIMELINE_AUTO;
  return plan;
}

// Why a published timeline does not render, or '' when it does: its control id is not the one Dynamics renders a
// timeline under, or its cell spans a single row. Any span of two rows or more renders, whatever its height.
// For the engine's OWN host (`host: true` — the section the build owns) the rows that back the span are part of
// the verdict too: the build converges them, so a cell of N rows without the N-1 rows under it is a fix not
// applied. A timeline a maker added is judged by the id and the span alone — the build never edits it, so a
// verdict on its rows could never be put right — and `auto` is in neither verdict.
function timelineProblem(found, { host = false } = {}) {
  const why = [];
  if (found.id !== TIMELINE_CONTROL_ID) why.push(`the control id is '${found.id === undefined || found.id === '' ? '(none)' : found.id}', not '${TIMELINE_CONTROL_ID}'`);
  if (found.rowspan < 2) why.push('its cell spans 1 row');
  else if (host && found.rowsBelow < found.rowspan - 1) why.push(`its cell spans ${found.rowspan} rows but only ${found.rowsBelow} row(s) follow it`);
  return why.join(' and ');
}

// What a build will do with a timeline host that is not in the shape Dynamics renders: repair it in place, or decline.
// `null` when there is nothing to repair or the repair can be made; otherwise why not:
//   'other-controls'  the section holds more than the timeline — the rows its cell needs would have to be inserted
//                     between the timeline and the other control, which would move it
//   'id-taken'        the host needs the id `notescontrol` and another control on the form already holds it
// One rule, applied to two different trees. The build judges the form as its field passes leave it (sdk-build.js,
// repairTimelineHost) — the fields the layout prunes or places elsewhere are gone from the host by then — so it passes
// nothing and every other cell counts. `--verify` reads the published form BEFORE any build, so it passes `leaving`: the
// cells it predicts those passes take out (verify-spec.js, notesHostInspector), which are no obstacle — and the cells it
// cannot predict, which it does not call an obstacle either, since a build may well take them out (timelineVerifyProblem
// says that it cannot tell). The section's other controls are judged first, as the build does.
function timelineRefusal(tabs, found, { leaving = [] } = {}) {
  const plan = timelineRepairPlan(found);
  if (!Object.keys(plan).length) return null;
  if (found.others.some((cell) => !leaving.includes(cell))) return 'other-controls';
  if (plan.id && controlIdTaken(tabs, TIMELINE_CONTROL_ID, found.control)) return 'id-taken';
  return null;
}

// How a form that asks for the timeline is told to put it right. A build of a spec that has not changed is skipped
// outright by `--changed-only` ("nothing to apply"), so a form an older version left — which no change to the spec
// reaches — is only repaired by a full build, and the advice has to say so or it sends the maker round in a loop.
const FULL_BUILD = 'a full build of the spec (not --changed-only, which skips a spec that has not changed)';

// "a", "a and b", "a, b and c" — items for a sentence; `word` is the conjunction ("or" for alternatives).
const joinList = (items, word = 'and') => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`);

// What `--verify` reports for a form that asks for the timeline, or '' when it carries one that renders: why none does
// and what to do about it, which depends on what a build WILL do about that form — so it says what the build will do,
// and for a form it declines to touch, what the maker has to do first.
//   tabs      the published form's tree (verify's parse of its FormXML)
//   isHost    whether a section is the engine's own Notes host, the one section a build repairs
//   inspect   optional, `(cell) → { name?, goes?, unsure?, destructive? }`: what a build does with each other cell of the host
//             BEFORE it judges the section. A build takes out of the section the fields the layout prunes or places elsewhere
//             first, so a cell it takes out is not in the way, and sending the maker to move it by hand would be work the
//             build does itself. `goes` says why the build takes the cell out (a clause), `destructive` that it removes
//             it (which a build only does with --allow-destructive), `name` how to call it. `unsure` is for a cell verify
//             cannot predict (a field the form has more than once, or one anchored to such a field, of which a build acts on
//             only one cell): it says why, and the advice says it cannot tell rather than promise a repair or send the maker
//             to do the build's work — in every shape of the advice, the taken-id one included, since freeing the id does not
//             decide what the build then does with the cell.
//             Without an inspector every other cell counts, as it does for a form nothing is known about.
function timelineVerifyProblem(tabs, isHost, { inspect } = {}) {
  const timelines = timelinesOf(tabs);
  const judged = (t) => timelineProblem(t, { host: isHost(t.section) });
  if (timelines.some((t) => !judged(t))) return '';
  const idTaken = controlIdTaken(tabs, TIMELINE_CONTROL_ID);
  const host = timelines.find((t) => isHost(t.section));
  if (host) {
    const doesNot = `the deployed form's timeline does not render: ${judged(host)}`;
    const cells = host.others.map((cell) => Object.assign({ cell }, inspect ? inspect(cell) : {}));
    const leaving = cells.filter((c) => c.goes);
    const unsure = cells.filter((c) => !c.goes && c.unsure);
    const staying = cells.filter((c) => !c.goes && !c.unsure);
    // What the build does first, so the maker is not surprised by it — least of all by a removal.
    const firstTakes = leaving.length
      ? `; the build first takes ${joinList(leaving.map((c) => `${c.name || 'a control'} (${c.goes})`))} out of the Notes section${leaving.some((c) => c.destructive) ? ', and removing a field needs --allow-destructive' : ''}`
      : '';
    // What it cannot tell. Such a cell is not counted as in the way below — the build may well take it out, and saying
    // otherwise would send the maker to do by hand what it does — and it is not promised to go either: it may stay, and the
    // maker is told what that looks like and what to do then.
    const names = [...new Set(unsure.map((c) => `${c.name || 'a control'} (${c.unsure})`))];
    const whichCell = 'a build acts on one cell of such a field, and which one depends on how it arranges the form';
    const ifLeft = `If its report says the timeline was left as it is, move ${unsure.length === 1 ? 'that cell' : 'those cells'} out of the section in the maker and run a full build again${unsure.some((c) => c.destructive) ? ' (removing a field needs --allow-destructive)' : ''}`;
    // Where the advice is not "a full build repairs it" — the section holds something that stays, or another control holds the
    // id — what verify cannot tell is whether the build takes the cell out. `also`: the advice has already said what the build
    // takes out first, and this is more of it. Freeing the id does not decide the cell, so the taken-id advice says it too.
    const cannotTell = (also) => (unsure.length
      ? `; verify cannot tell whether the build ${also ? 'also ' : ''}takes ${joinList(names)} out of the Notes section first — ${whichCell}. ${ifLeft}`
      : '');
    // Where a full build WOULD repair the host but for what verify cannot tell, the advice leads with that condition. "Run a full
    // build to repair it in place" would promise what may not happen — and be printed again, word for word, after a build that
    // has already left the timeline.
    const mayLeave = unsure.length
      ? `; the build repairs the timeline in place unless it leaves ${joinList(names, 'or')} in the Notes section, and verify cannot tell whether it does — ${whichCell}. ${ifLeft}`
      : '';
    switch (timelineRefusal(tabs, host, { leaving: leaving.concat(unsure).map((c) => c.cell) })) {
      case 'other-controls': {
        // Without an inspector nothing is known about those cells, so every one is in the way and none can be named.
        if (!inspect) return `${doesNot} — the Notes section also holds other controls, so a build leaves it as it is; move them out of it, or delete the section, in the maker, then run ${FULL_BUILD}`;
        // With one, the ones in the way are exactly those a build does not take out, and they are named when they can be.
        const named = staying.map((c) => c.name).filter(Boolean);
        const unnamed = staying.length - named.length;
        const what = joinList(named.concat(unnamed ? [`${unnamed} other control${unnamed === 1 ? '' : 's'}`] : []));
        return `${doesNot} — the Notes section also holds ${what}, which a build does not remove, so the build leaves the section as it is; move ${staying.length === 1 ? 'it' : 'them'} out of it, or delete the section, in the maker, then run ${FULL_BUILD}${firstTakes}${cannotTell(leaving.length > 0)}`;
      }
      case 'id-taken':
        // What a build takes out first is not said here, so what it cannot tell is not "also" taken out.
        return `${doesNot} — another control on the form already uses the id '${TIMELINE_CONTROL_ID}', so a build cannot give this timeline that id; remove or rename one of the two in the maker, then run ${FULL_BUILD}${cannotTell(false)}`;
      default:
        return `${doesNot} — run ${FULL_BUILD}${unsure.length ? '' : ' to repair it in place'}${firstTakes}${mayLeave}`;
    }
  }
  // A timeline a maker added: a build never edits it, and adds a Notes section of its own beside it — unless a control
  // already holds the id, since a second `notescontrol` would be a duplicate.
  if (timelines.length) {
    const doesNot = `the deployed form's timeline does not render: ${judged(timelines[0])} — it is a timeline the build did not add, so a build leaves it as it is`;
    return idTaken
      ? `${doesNot}, and adds no Notes section while a control uses the id '${TIMELINE_CONTROL_ID}'; fix it in the maker (the id '${TIMELINE_CONTROL_ID}' and a cell spanning more than one row) or delete it, then run ${FULL_BUILD}`
      : `${doesNot}; run ${FULL_BUILD} to add the Notes section beside it`;
  }
  const none = 'the spec asks for the Notes timeline, but the deployed form has no timeline control';
  return idTaken
    ? `${none}, and another control already uses the id '${TIMELINE_CONTROL_ID}' that a timeline needs, so a build adds none — remove or rename that control in the maker, then run ${FULL_BUILD}`
    : `${none} — run ${FULL_BUILD} to add it`;
}

module.exports = {
  TIMELINE_CLASS_ID,
  TIMELINE_CONTROL_ID,
  TIMELINE_ROWSPAN,
  TIMELINE_AUTO,
  isTimelineControl,
  timelineCellIntent,
  timelineRowsIntent,
  wantsTimeline,
  timelineInSection,
  timelinesOf,
  controlIdTaken,
  timelineRepairPlan,
  timelineProblem,
  timelineRefusal,
  timelineVerifyProblem,
  FULL_BUILD,
};
