/*
 * obs-export core: turn a saved Observable Notebooks 2.0 page into the open
 * <notebook> .html format. Pure string processing, so it runs in the browser
 * (exportnb.html) and in Node (tools/obs-export.mjs).
 *
 * Observable pages are Next.js apps; the notebook source is embedded as
 * "flight data": self.__next_f.push([1, "..."]) chunks, joined into rows
 * ("id:payload", or "id:T<hexbytes>,<text>"), with "$id" references between
 * rows. This is an internal format, not an API, so it may change.
 */

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

const escapeText = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/\u00a0/g, "&nbsp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/\u00a0/g, "&nbsp;")
    .replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// 1. Getting the flight data
// ---------------------------------------------------------------------------

/** Pull every `self.__next_f.push([1, "..."])` chunk out of page HTML and join them. */
export function flightFromHtml(html) {
  const pushCall = /self\.__next_f\.push\(\[1\s*,\s*("(?:\\.|[^"\\])*")\s*\]\)/g;
  let flight = "";
  let match;
  while ((match = pushCall.exec(html))) {
    try {
      flight += JSON.parse(match[1]); // the chunk is a JSON string literal
    } catch {
      /* skip malformed chunk */
    }
  }
  return flight;
}

// ---------------------------------------------------------------------------
// 2. Splitting flight data into rows
// ---------------------------------------------------------------------------

/** UTF-8 byte length of one code point. */
const utf8Length = (cp) => (cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4);

/**
 * Flight rows look like either
 *     "1a:{...json...}\n"          (payload runs to end of line)
 *     "1b:T<hexByteLength>,<text>" (text payload of exactly that many UTF-8 bytes,
 *                                   may itself contain newlines)
 * Returns { rowId: payloadString }.
 */
export function parseRows(flight) {
  const rows = {};
  const n = flight.length;
  let i = 0;

  while (i < n) {
    // row id: everything up to ':'
    const idStart = i;
    while (i < n && flight[i] !== ":") i++;
    if (i >= n) break;
    const id = flight.slice(idStart, i);
    i++; // skip ':'

    let payload;
    if (flight[i] === "T") {
      // length-prefixed text row
      const comma = flight.indexOf(",", i);
      const byteLength = parseInt(flight.slice(i + 1, comma), 16);
      const textStart = comma + 1;
      let end = textStart;
      let bytes = 0;
      while (end < n && bytes < byteLength) {
        const cp = flight.codePointAt(end);
        bytes += utf8Length(cp);
        end += cp > 0xffff ? 2 : 1; // surrogate pair = 2 UTF-16 units
      }
      payload = flight.slice(textStart, end);
      i = end;
    } else {
      // ordinary row: to end of line
      let eol = flight.indexOf("\n", i);
      if (eol < 0) eol = n;
      payload = flight.slice(i, eol);
      i = eol;
    }

    rows[id] = payload;
    if (flight[i] === "\n") i++;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 3. Finding the notebook object
// ---------------------------------------------------------------------------

/** Given the index of a '{' in `s`, return the balanced {...} substring (string-aware). */
function balancedObject(s, start) {
  let depth = 0, inString = false, escaped = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, k + 1);
  }
  return null;
}

/** Parse the object at `start`; accept it only if it looks like a notebook (has cells). */
function notebookAt(s, start) {
  const text = balancedObject(s, start);
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    return obj && Array.isArray(obj.cells) && obj.cells.length ? obj : null;
  } catch {
    return null;
  }
}

export function findNotebook(flight, rows) {
  // Strategy A: a "body":{ ... } property
  for (const m of flight.matchAll(/"body":\{/g)) {
    const nb = notebookAt(flight, m.index + m[0].length - 1);
    if (nb) return nb;
  }
  // Strategy B: any object starting {"title":"
  for (const m of flight.matchAll(/\{"title":"/g)) {
    const nb = notebookAt(flight, m.index);
    if (nb) return nb;
  }
  // Strategy C: a whole row that is the notebook object
  for (const payload of Object.values(rows)) {
    if (payload[0] === "{" && payload.indexOf('"cells":[') > 0) {
      const nb = notebookAt(payload, 0);
      if (nb) return nb;
    }
  }
  throw new Error(
    "No Notebooks 2.0 source found on this page. " +
    "This works on Notebooks 2.0 only — classic notebooks are not supported."
  );
}

// ---------------------------------------------------------------------------
// 4. Resolving "$..." references
// ---------------------------------------------------------------------------

/**
 * Values in the flight data may be references:
 *   "$$text"   -> literal "$text"  (escaped dollar)
 *   "$1f"      -> contents of row 1f   (also "$W1f", "$L1f")
 * Anything else is returned unchanged.
 */
export function makeResolver(rows) {
  return function resolve(value) {
    if (typeof value !== "string") return value;
    if (value.startsWith("$$")) return value.slice(1);

    const ref = value.match(/^\$[WL]?([0-9a-f]+)$/);
    if (!ref) return value;

    const row = rows[ref[1]];
    if (row == null) return value;
    if (row[0] === '"') {
      try { return JSON.parse(row); } catch { /* fall through to raw text */ }
    }
    return row;
  };
}

// ---------------------------------------------------------------------------
// 5. Writing the .html notebook
// ---------------------------------------------------------------------------

// Observable cell "mode" -> <script type="...">
const CELL_TYPES = {
  js: "module",
  ts: "text/x-typescript",
  ojs: "application/vnd.observable.javascript",
  md: "text/markdown",
  html: "text/html",
  tex: "application/x-tex",
  dot: "text/vnd.graphviz",
  sql: "application/sql",
  "sql.view": "application/sql+view",
  node: "application/vnd.node.javascript",
  python: "text/x-python",
  py: "text/x-python",
  r: "text/x-r",
};

const isDefined = (v) => v != null && v !== "$undefined";

/** Stop cell source containing "</script" from closing the tag early. */
const guardScriptEnd = (s) => String(s).replace(/<(?=\\*\/script(\s|>))/gi, "<\\");

/** Indent source by 4 spaces inside its <script>, leaving blank lines empty. */
const indentSource = (s) =>
  "\n" +
  String(s).split(/\r\n?|\n/).map((line) => (line.trim() ? "    " + line : "")).join("\n") +
  "\n  ";

export function notebookToHtml(nb, resolve) {
  let theme = resolve(nb.theme);
  if (theme && typeof theme === "object") theme = `light-dark(${theme.light}, ${theme.dark})`;
  const title = isDefined(resolve(nb.title)) ? resolve(nb.title) : "";

  let out =
    `<!doctype html>\n` +
    `<notebook theme="${escapeAttr(isDefined(theme) ? theme : "air")}"` +
    `${nb.readOnly === true ? ' readonly=""' : ""}>\n` +
    `  <title>${escapeText(title)}</title>\n`;

  for (const cell of nb.cells) {
    let attrs = ` id="${escapeAttr(isDefined(cell.id) ? cell.id : "")}"` +
                ` type="${CELL_TYPES[cell.mode] || "module"}"`;
    if (cell.pinned === true) attrs += ' pinned=""';
    if (cell.hidden === true) attrs += ' hidden=""';
    for (const key of ["database", "output", "format"]) {
      const v = resolve(cell[key]);
      if (isDefined(v) && v !== "") attrs += ` ${key}="${escapeAttr(v)}"`;
    }
    const source = resolve(cell.value);
    out += `  <script${attrs}>${indentSource(guardScriptEnd(source == null ? "" : source))}</script>\n`;
  }
  return out + "</notebook>\n";
}

/** "My Notebook!" -> "my-notebook.html" */
export function filenameFor(title) {
  const base = title || "notebook";
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return (slug || "notebook") + ".html";
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

/**
 * Convert page HTML (already fetched/saved) to a notebook.
 * @returns {{html: string, title: string, cellCount: number, filename: string}}
 */
export function exportFromPageHtml(pageHtml) {
  const flight = flightFromHtml(pageHtml);
  if (!flight) throw new Error("No Observable page data found in that HTML.");
  const rows = parseRows(flight);
  const nb = findNotebook(flight, rows);
  const resolve = makeResolver(rows);
  const t = resolve(nb.title);
  const title = isDefined(t) ? t : "";
  return {
    html: notebookToHtml(nb, resolve),
    title,
    cellCount: nb.cells.length,
    filename: filenameFor(title),
  };
}
