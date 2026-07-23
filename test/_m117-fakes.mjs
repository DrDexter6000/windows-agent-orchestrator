// test/_m117-fakes.mjs
//
// Minimal fake parser for M11-7 ProcessBackend tests. A parser must expose
// feed(chunk) -> event[] and flush() -> event[]. This one produces no events,
// letting the test focus on env/redaction behavior rather than parsing.

export class FakeStreamParser {
  feed(_chunk) {
    return [];
  }
  flush() {
    return [];
  }
}
