'use strict';

// TAP v13 reporter. One output stream — write line by line.
//
// Structure:
//   TAP version 13
//   1..<N total fixtures>
//   # Subtest: fixture-1-account-gallery
//       1..<M assertions for this fixture>
//       ok 1 - assertion text
//       not ok 2 - assertion text
//         ---
//         reason: '...'
//         ...
//       ok 3 - assertion text # SKIP not implemented
//   ok 1 - fixture-1-account-gallery
//   # Subtest: fixture-2-mock-dashboard
//       ...
//   1..N
//
// A skip grades nothing, so a fixture passes only when at least one assertion was graded and none failed. A fixture with no graded
// assertion — every one skipped, or none at all — is UNSCORED: its line takes TAP's skip directive,
//   ok 3 - fixture-3-kept-page # SKIP no expectation graded
// and it is counted apart from the passed fixtures, so the summary never credits ungraded work as a pass. An unscored fixture does not fail
// the run (the exit code is non-zero only for a failed fixture).
//
// Failure diagnostics currently include only `reason:`. Additional fields
// (e.g., `file:`) can be added by extending `assertion()` if needed.
//
// Aggregate result emitted at the end as `# tests N`, `# pass X`, etc. Release and test tooling parse the
// `# fixtures N (pass P, fail F)` line, so it keeps that exact form and stays the only line that starts with
// `# fixtures`; unscored fixtures get one line of their own, `# unscored fixtures U`, written only when U > 0 — a
// run without one prints exactly what it always printed.

class TapReporter {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.totalTests = 0;
    this.totalPass = 0;
    this.totalFail = 0;
    this.totalSkip = 0;
    this.fixturePass = 0;
    this.fixtureFail = 0;
    this.fixtureUnscored = 0;
    this.fixtureIndex = 0;
    this.totalFixtures = 0;
  }

  write(line) { this.stream.write(line + '\n'); }

  start(totalFixtures) {
    this.totalFixtures = totalFixtures;
    this.write('TAP version 13');
    this.write(`1..${totalFixtures}`);
  }

  startFixture(name) {
    this.fixtureIndex += 1;
    this._currentName = name;
    this._currentAssertions = [];
    this._currentFail = false;
    this.write(`# Subtest: ${name}`);
  }

  assertion(text, result) {
    this.totalTests += 1;
    const idx = this._currentAssertions.length + 1;
    this._currentAssertions.push({ text, result });
    if (result.status === 'pass') {
      this.totalPass += 1;
      this.write(`    ok ${idx} - ${text}`);
    } else if (result.status === 'skip') {
      this.totalSkip += 1;
      this.write(`    ok ${idx} - ${text} # SKIP ${result.reason}`);
    } else {
      this.totalFail += 1;
      this._currentFail = true;
      this.write(`    not ok ${idx} - ${text}`);
      this.write(`      ---`);
      this.write(`      reason: ${JSON.stringify(result.reason)}`);
      this.write(`      ...`);
    }
  }

  endFixture() {
    this.write(`    1..${this._currentAssertions.length}`);
    if (this._currentFail) {
      this.fixtureFail += 1;
      this.write(`not ok ${this.fixtureIndex} - ${this._currentName}`);
    } else if (this._currentAssertions.some(({ result }) => result.status === 'pass')) {
      this.fixturePass += 1;
      this.write(`ok ${this.fixtureIndex} - ${this._currentName}`);
    } else {
      this.fixtureUnscored += 1;
      this.write(`ok ${this.fixtureIndex} - ${this._currentName} # SKIP no expectation graded`);
    }
    this._currentName = null;
    this._currentAssertions = [];
    this._currentFail = false;
  }

  end() {
    this.write(`# tests ${this.totalTests}`);
    this.write(`# pass  ${this.totalPass}`);
    this.write(`# fail  ${this.totalFail}`);
    this.write(`# skip  ${this.totalSkip}`);
    this.write(`# fixtures ${this.totalFixtures} (pass ${this.fixturePass}, fail ${this.fixtureFail})`);
    if (this.fixtureUnscored > 0) this.write(`# unscored fixtures ${this.fixtureUnscored}`);
  }

  get exitCode() {
    return this.fixtureFail > 0 ? 1 : 0;
  }
}

module.exports = { TapReporter };
