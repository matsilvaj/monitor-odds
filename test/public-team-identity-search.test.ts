import assert from "node:assert/strict";
import test from "node:test";
import { parseDuckDuckGoResults } from "../src/services/public-team-identity-search.js";

test("extracts and decodes public search result links", () => {
  const html = [
    '<div class="result">',
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.wikidata.org%2Fwiki%2FQ500988">',
    "FK <b>Zalgiris</b> - Wikidata",
    "</a>",
    "</div>"
  ].join("");

  assert.deepEqual(parseDuckDuckGoResults(html), [
    {
      uri: "https://www.wikidata.org/wiki/Q500988",
      title: "FK Zalgiris - Wikidata",
      snippet: "FK Zalgiris - Wikidata",
      provider: "duckduckgo"
    }
  ]);
});

test("ignores malformed and non-http search result links", () => {
  assert.deepEqual(parseDuckDuckGoResults('<a class="result__a" href="javascript:void(0)">x</a>'), []);
});
