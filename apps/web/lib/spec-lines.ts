/**
 * Best-effort mapping from a validation issue path like
 * "accounts.initial[0].address" to a 1-based line number in the YAML source,
 * so spec errors can point into the editor. Validation paths are semantic,
 * not positional, so this walks the indentation structure of the text:
 * block mappings and sequences resolve exactly; flow-style values
 * ({ enabled: false } on one line) resolve to the line holding them. Returns
 * the deepest line reached, or null when the top-level key is absent from
 * the text entirely (e.g. a field supplied by the network profile).
 */

interface Tok {
  /** 1-based source line. */
  line: number;
  indent: number;
  /** Trimmed content; blank and comment-only lines are dropped. */
  text: string;
}

function parseSegments(path: string): (string | number)[] {
  const segs: (string | number)[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (m[2] !== undefined) segs.push(Number(m[2]));
    else if (m[1]) segs.push(m[1]);
  }
  return segs;
}

export function specPathLine(text: string, path: string): number | null {
  const segs = parseSegments(path);
  if (segs.length === 0) return null;

  let toks: Tok[] = [];
  text.split("\n").forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    toks.push({ line: i + 1, indent: raw.length - raw.trimStart().length, text: trimmed });
  });

  let found: number | null = null;
  for (const seg of segs) {
    if (toks.length === 0) break;
    const childIndent = toks[0]!.indent;

    if (typeof seg === "number") {
      // count sequence items ("- ...") at the block's base indent
      let count = -1;
      let idx = -1;
      for (let t = 0; t < toks.length; t++) {
        const tok = toks[t]!;
        if (tok.indent !== childIndent) continue;
        if (tok.text !== "-" && !tok.text.startsWith("- ")) continue;
        count++;
        if (count === seg) {
          idx = t;
          break;
        }
      }
      if (idx < 0) break;
      const item = toks[idx]!;
      found = item.line;
      let end = toks.length;
      for (let t = idx + 1; t < toks.length; t++) {
        if (toks[t]!.indent <= childIndent) {
          end = t;
          break;
        }
      }
      const block = toks.slice(idx + 1, end);
      // "- name: treasury" carries the item's first key on the item line
      const inlined = item.text.replace(/^-\s*/, "");
      if (inlined) block.unshift({ line: item.line, indent: item.indent + 2, text: inlined });
      toks = block;
      continue;
    }

    let idx = -1;
    let rest = "";
    for (let t = 0; t < toks.length; t++) {
      const tok = toks[t]!;
      if (tok.indent !== childIndent) continue; // nested content of a sibling
      const m = tok.text.match(/^([^:\s]+):(.*)$/);
      if (m && m[1] === seg) {
        idx = t;
        rest = m[2]!.trim();
        break;
      }
    }
    if (idx < 0) break;
    found = toks[idx]!.line;
    if (rest && !rest.startsWith("#")) {
      // scalar or flow-style value on this line: cannot descend further
      toks = [];
      continue;
    }
    let end = toks.length;
    for (let t = idx + 1; t < toks.length; t++) {
      if (toks[t]!.indent <= childIndent) {
        end = t;
        break;
      }
    }
    toks = toks.slice(idx + 1, end);
  }
  return found;
}
